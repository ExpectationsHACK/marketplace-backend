import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, RequireAuth, type AuthUser } from '../common/auth.js';
import {
  listingInclude,
  sellerIdsAmong,
  toListing,
  toMessage,
  toPublicUser,
  type ListingDto,
  type MessageDto,
  type PublicUser,
} from '../common/mappers.js';
import { PrismaService } from '../prisma/prisma.service.js';

export class OpenConversationDto {
  /** The other person (usually the seller). */
  @IsString()
  @IsNotEmpty()
  withUserId: string;

  /** The listing the chat is about, if any. It must be one of yours or theirs. */
  @IsOptional()
  @IsString()
  listingId?: string;
}

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;
}

export class MessagesQueryDto {
  /** Return messages sent before this ISO timestamp (for loading older history). */
  @IsOptional()
  @IsDateString()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}

export interface ConversationSummary {
  id: string;
  listingId?: string;
  listing?: ListingDto;
  /** The other person, with what the chat UI shows about them (trust, response time). */
  withUser: PublicUser;
  /**
   * Where "Continue on WhatsApp" goes: their shop's number, else their own if
   * they sell. Absent for buyers, whose numbers are never shared.
   */
  whatsappNumber?: string;
  lastMessage?: MessageDto;
  lastMessageAt: string;
  /** True when the latest message is from the other person and newer than my last read. */
  unread: boolean;
}

type ConversationRow = {
  id: string;
  listingId: string | null;
  lastMessageAt: Date;
  listing: Parameters<typeof toListing>[0] | null;
  messages: Parameters<typeof toMessage>[0][];
  participants: {
    userId: string;
    lastReadAt: Date | null;
    user: Parameters<typeof toPublicUser>[0] & { storefront: { whatsappNumber: string } | null };
  }[];
};

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  private summaryInclude() {
    return {
      listing: { include: listingInclude },
      messages: { orderBy: { createdAt: 'desc' as const }, take: 1 },
      participants: { include: { user: { include: { storefront: { select: { whatsappNumber: true } } } } } },
    };
  }

  /** Summaries for these rows from `userId`'s side; one query decides whose numbers are public. */
  private async toSummaries(userId: string, rows: ConversationRow[]): Promise<ConversationSummary[]> {
    const others = rows.map((c) => c.participants.find((p) => p.userId !== userId)!);
    const sellers = await sellerIdsAmong(this.prisma, [...new Set(others.map((o) => o.userId))]);
    return rows.map((c, i) => {
      const me = c.participants.find((p) => p.userId === userId);
      const other = others[i];
      const last = c.messages[0];
      const sells = sellers.has(other.userId);
      return {
        id: c.id,
        listingId: c.listingId ?? undefined,
        listing: c.listing ? toListing(c.listing) : undefined,
        withUser: toPublicUser(other.user, sells),
        whatsappNumber: other.user.storefront?.whatsappNumber ?? (sells ? other.user.phone : undefined),
        lastMessage: last ? toMessage(last) : undefined,
        lastMessageAt: c.lastMessageAt.toISOString(),
        unread: Boolean(last && last.senderId !== userId && (!me?.lastReadAt || me.lastReadAt < last.createdAt)),
      };
    });
  }

  async list(user: AuthUser): Promise<ConversationSummary[]> {
    const rows = await this.prisma.conversation.findMany({
      where: { participants: { some: { userId: user.id } } },
      include: this.summaryInclude(),
      orderBy: { lastMessageAt: 'desc' },
    });
    return this.toSummaries(user.id, rows);
  }

  /** Returns the existing thread between these two people about this listing, or opens one. */
  async open(user: AuthUser, dto: OpenConversationDto): Promise<ConversationSummary> {
    if (dto.withUserId === user.id) throw new BadRequestException("You can't message yourself");
    const other = await this.prisma.user.count({ where: { id: dto.withUserId } });
    if (!other) throw new NotFoundException('User not found');
    if (dto.listingId) {
      const listing = await this.prisma.listing.findUnique({ where: { id: dto.listingId }, select: { sellerId: true } });
      if (!listing) throw new NotFoundException('Listing not found');
      // A chat shows the listing as its subject; it can't borrow someone else's (a scammer "about" a trusted seller's item).
      if (listing.sellerId !== dto.withUserId && listing.sellerId !== user.id) {
        throw new BadRequestException('That listing belongs to someone else');
      }
    }

    const existing = await this.prisma.conversation.findFirst({
      where: {
        listingId: dto.listingId ?? null,
        AND: [{ participants: { some: { userId: user.id } } }, { participants: { some: { userId: dto.withUserId } } }],
      },
      include: this.summaryInclude(),
    });
    if (existing) return (await this.toSummaries(user.id, [existing]))[0];

    const created = await this.prisma.conversation.create({
      data: {
        listingId: dto.listingId,
        participants: { create: [{ userId: user.id, lastReadAt: new Date() }, { userId: dto.withUserId }] },
      },
      include: this.summaryInclude(),
    });
    return (await this.toSummaries(user.id, [created]))[0];
  }

  private async assertParticipant(user: AuthUser, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { participants: { select: { userId: true } } },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (!conversation.participants.some((p) => p.userId === user.id)) throw new ForbiddenException('Not your conversation');
  }

  async get(user: AuthUser, id: string) {
    await this.assertParticipant(user, id);
    const row = await this.prisma.conversation.findUniqueOrThrow({ where: { id }, include: this.summaryInclude() });
    const [summary] = await this.toSummaries(user.id, [row]);
    return { ...summary, messages: await this.messages(user, id, { limit: 50 }) };
  }

  /** Oldest first, so a client can append in order. */
  async messages(user: AuthUser, id: string, q: MessagesQueryDto): Promise<MessageDto[]> {
    await this.assertParticipant(user, id);
    const rows = await this.prisma.message.findMany({
      where: { conversationId: id, ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    return rows.reverse().map(toMessage);
  }

  async send(user: AuthUser, id: string, dto: SendMessageDto): Promise<MessageDto> {
    await this.assertParticipant(user, id);
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('Write a message first');
    const now = new Date();
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({ data: { conversationId: id, senderId: user.id, body, createdAt: now } }),
      this.prisma.conversation.update({ where: { id }, data: { lastMessageAt: now } }),
      this.prisma.conversationParticipant.update({
        where: { conversationId_userId: { conversationId: id, userId: user.id } },
        data: { lastReadAt: now },
      }),
    ]);
    return toMessage(message);
  }

  async markRead(user: AuthUser, id: string) {
    await this.assertParticipant(user, id);
    await this.prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId: id, userId: user.id } },
      data: { lastReadAt: new Date() },
    });
  }
}

@ApiTags('conversations')
@ApiBearerAuth()
@RequireAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  /** My chats, most recent activity first (drives the inbox and the chat bar). */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.conversations.list(user);
  }

  /** Open (or reopen) a chat with a person, optionally about one of their listings or yours. */
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  open(@CurrentUser() user: AuthUser, @Body() dto: OpenConversationDto) {
    return this.conversations.open(user, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.get(user, id);
  }

  @Get(':id/messages')
  messages(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: MessagesQueryDto) {
    return this.conversations.messages(user, id, q);
  }

  @Post(':id/messages')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  send(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SendMessageDto) {
    return this.conversations.send(user, id, dto);
  }

  @Post(':id/read')
  @HttpCode(204)
  read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.markRead(user, id);
  }
}

@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
