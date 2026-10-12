import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { CurrentUser, RequireAuth, type AuthUser } from '../common/auth.js';
import { IMAGE_URL_PATTERN } from '../common/dto.js';
import { isUniqueViolation } from '../common/errors.js';
import {
  effectiveStatus,
  listingInclude,
  sellerSelect,
  storefrontInclude,
  toListing,
  toMe,
  toMessage,
  toSeller,
  toStorefront,
  type ListingDto,
  type MessageDto,
  type SellerSummary,
  type StorefrontDto,
} from '../common/mappers.js';
import { PrismaService } from '../prisma/prisma.service.js';

const RECENT_LIMIT = 12;

// ------------------------------------------------------------------ DTOs

export type RecentEntry =
  | { kind: 'listing'; id: string; at: string; listing: ListingDto }
  | { kind: 'shop'; id: string; at: string; storefront: StorefrontDto };

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(IMAGE_URL_PATTERN, { message: 'avatarUrl must be a path returned by POST /uploads' })
  avatarUrl?: string;

  // No responseTime: buyers read it as a trust signal, so a person can't write their own.
}

export class MyListingsQueryDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'SOLD', 'EXPIRED', 'REMOVED'])
  status?: 'ACTIVE' | 'SOLD' | 'EXPIRED' | 'REMOVED';
}

export class RecordViewDto {
  @IsIn(['listing', 'shop'])
  kind: 'listing' | 'shop';

  @IsString()
  @Length(1, 40)
  id: string;
}

export type DashboardTask =
  | { type: 'REPLY_NEEDED'; conversationId: string; listingId?: string; withUser: SellerSummary; lastMessage: MessageDto }
  | { type: 'OUT_OF_STOCK'; productId: string; title: string }
  | { type: 'LISTING_EXPIRED'; listingId: string; title: string }
  | { type: 'GET_VERIFIED' };

// ------------------------------------------------------------------ service

@Injectable()
export class MeService {
  constructor(private readonly prisma: PrismaService) {}

  async me(user: AuthUser) {
    return toMe(await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } }));
  }

  async update(user: AuthUser, dto: UpdateMeDto) {
    try {
      const row = await this.prisma.user.update({
        where: { id: user.id },
        data: { name: dto.name?.trim(), email: dto.email?.toLowerCase(), avatarUrl: dto.avatarUrl },
      });
      return toMe(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('That email is already used by another account');
      throw error;
    }
  }

  async storefront(user: AuthUser) {
    const row = await this.prisma.storefront.findUnique({ where: { ownerId: user.id }, include: storefrontInclude });
    if (!row) throw new NotFoundException({ code: 'NO_STOREFRONT', message: "You haven't opened a shop yet" });
    return toStorefront(row);
  }

  /** Every listing I posted, any status (status filter is applied after expiry is computed). */
  async listings(user: AuthUser, status?: MyListingsQueryDto['status']): Promise<ListingDto[]> {
    const rows = await this.prisma.listing.findMany({
      where: { sellerId: user.id },
      include: listingInclude,
      orderBy: { createdAt: 'desc' },
    });
    const all = rows.map(toListing);
    return status ? all.filter((l) => l.status === status) : all;
  }

  async dashboard(user: AuthUser) {
    const [me, shop, listings, conversations] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { verified: true } }),
      this.prisma.storefront.findUnique({
        where: { ownerId: user.id },
        select: { followersCount: true, responseRate: true, products: { where: { inStock: false }, select: { id: true, title: true } } },
      }),
      this.prisma.listing.findMany({ where: { sellerId: user.id }, select: { id: true, title: true, status: true, expiresAt: true } }),
      this.prisma.conversation.findMany({
        where: { participants: { some: { userId: user.id } } },
        include: {
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          participants: { where: { userId: { not: user.id } }, include: { user: { select: sellerSelect } } },
        },
        orderBy: { lastMessageAt: 'desc' },
      }),
    ]);

    const tasks: DashboardTask[] = [];
    for (const c of conversations) {
      const last = c.messages[0];
      const other = c.participants[0]?.user;
      if (last && other && last.senderId !== user.id) {
        tasks.push({
          type: 'REPLY_NEEDED',
          conversationId: c.id,
          listingId: c.listingId ?? undefined,
          withUser: toSeller(other),
          lastMessage: toMessage(last),
        });
      }
    }
    for (const p of shop?.products ?? []) tasks.push({ type: 'OUT_OF_STOCK', productId: p.id, title: p.title });
    for (const l of listings) {
      if (effectiveStatus(l) === 'EXPIRED') tasks.push({ type: 'LISTING_EXPIRED', listingId: l.id, title: l.title });
    }
    if (!me.verified) tasks.push({ type: 'GET_VERIFIED' });

    return {
      stats: {
        followers: shop?.followersCount ?? null,
        liveListings: listings.filter((l) => effectiveStatus(l) === 'ACTIVE').length,
        openChats: conversations.length,
        responseRate: shop?.responseRate ?? null,
      },
      tasks,
    };
  }

  // ---- library

  /**
   * Everything "Saved & following" shows, with the records embedded so the
   * sidebar, the Saved items page and the home shelves need one request.
   * Removed listings drop out; sold and expired ones stay so the UI can say so.
   */
  async library(user: AuthUser) {
    const [saved, following, recent] = await Promise.all([
      this.prisma.savedListing.findMany({
        where: { userId: user.id, listing: { status: { not: 'REMOVED' } } },
        include: { listing: { include: listingInclude } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.follow.findMany({
        where: { userId: user.id },
        include: { storefront: { include: storefrontInclude } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.recentView.findMany({ where: { userId: user.id }, orderBy: { viewedAt: 'desc' }, take: RECENT_LIMIT }),
    ]);

    const ids = (kind: 'LISTING' | 'SHOP') => recent.filter((r) => r.kind === kind).map((r) => r.targetId);
    const [recentListings, recentShops] = await Promise.all([
      this.prisma.listing.findMany({ where: { id: { in: ids('LISTING') }, status: { not: 'REMOVED' } }, include: listingInclude }),
      this.prisma.storefront.findMany({ where: { id: { in: ids('SHOP') } }, include: storefrontInclude }),
    ]);
    const listingById = new Map(recentListings.map((l) => [l.id, toListing(l)]));
    const shopById = new Map(recentShops.map((s) => [s.id, toStorefront(s)]));

    return {
      saved: saved.map((s) => ({ listingId: s.listingId, at: s.createdAt.toISOString(), listing: toListing(s.listing) })),
      following: following.map((f) => ({ storefrontId: f.storefrontId, at: f.createdAt.toISOString(), storefront: toStorefront(f.storefront) })),
      recent: recent.flatMap((r): RecentEntry[] => {
        const at = r.viewedAt.toISOString();
        if (r.kind === 'LISTING') {
          const listing = listingById.get(r.targetId);
          return listing ? [{ kind: 'listing', id: r.targetId, at, listing }] : [];
        }
        const storefront = shopById.get(r.targetId);
        return storefront ? [{ kind: 'shop', id: r.targetId, at, storefront }] : [];
      }),
    };
  }

  async savedListings(user: AuthUser) {
    const rows = await this.prisma.savedListing.findMany({
      where: { userId: user.id, listing: { status: { not: 'REMOVED' } } },
      include: { listing: { include: listingInclude } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ savedAt: r.createdAt.toISOString(), listing: toListing(r.listing) }));
  }

  async save(user: AuthUser, listingId: string) {
    const listing = await this.prisma.listing.count({ where: { id: listingId } });
    if (!listing) throw new NotFoundException('Listing not found');
    await this.prisma.savedListing.upsert({
      where: { userId_listingId: { userId: user.id, listingId } },
      create: { userId: user.id, listingId },
      update: {},
    });
  }

  async unsave(user: AuthUser, listingId: string) {
    await this.prisma.savedListing.deleteMany({ where: { userId: user.id, listingId } });
  }

  async following(user: AuthUser) {
    const rows = await this.prisma.follow.findMany({
      where: { userId: user.id },
      include: { storefront: { include: storefrontInclude } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => toStorefront(r.storefront));
  }

  /** Idempotent; the follower count only moves when the follow is new. */
  async follow(user: AuthUser, storefrontId: string) {
    const shop = await this.prisma.storefront.findUnique({ where: { id: storefrontId }, select: { ownerId: true } });
    if (!shop) throw new NotFoundException('Shop not found');
    if (shop.ownerId === user.id) throw new BadRequestException("You can't follow your own shop");
    await this.prisma.$transaction(async (tx) => {
      const exists = await tx.follow.findUnique({ where: { userId_storefrontId: { userId: user.id, storefrontId } } });
      if (exists) return;
      await tx.follow.create({ data: { userId: user.id, storefrontId } });
      await tx.storefront.update({ where: { id: storefrontId }, data: { followersCount: { increment: 1 } } });
    });
  }

  async unfollow(user: AuthUser, storefrontId: string) {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.follow.deleteMany({ where: { userId: user.id, storefrontId } });
      if (count) await tx.storefront.update({ where: { id: storefrontId }, data: { followersCount: { decrement: 1 } } });
    });
  }

  async recordView(user: AuthUser, dto: RecordViewDto) {
    const kind = dto.kind === 'listing' ? 'LISTING' : 'SHOP';
    const exists =
      kind === 'LISTING'
        ? await this.prisma.listing.count({ where: { id: dto.id } })
        : await this.prisma.storefront.count({ where: { id: dto.id } });
    if (!exists) throw new NotFoundException(`${dto.kind === 'listing' ? 'Listing' : 'Shop'} not found`);
    await this.prisma.recentView.upsert({
      where: { userId_kind_targetId: { userId: user.id, kind, targetId: dto.id } },
      create: { userId: user.id, kind, targetId: dto.id },
      update: { viewedAt: new Date() },
    });
    // Keep only the most recent few.
    const stale = await this.prisma.recentView.findMany({
      where: { userId: user.id },
      orderBy: { viewedAt: 'desc' },
      skip: RECENT_LIMIT,
      select: { id: true },
    });
    if (stale.length) await this.prisma.recentView.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }
}

// ------------------------------------------------------------------ controller

@ApiTags('me')
@ApiBearerAuth()
@RequireAuth()
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.me.me(user);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.me.update(user, dto);
  }

  @Get('storefront')
  storefront(@CurrentUser() user: AuthUser) {
    return this.me.storefront(user);
  }

  @Get('listings')
  listings(@CurrentUser() user: AuthUser, @Query() q: MyListingsQueryDto) {
    return this.me.listings(user, q.status);
  }

  /** Seller hub: headline numbers plus everything waiting on the seller. */
  @Get('dashboard')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.me.dashboard(user);
  }

  /** Ids and timestamps for saved items, follows and recently viewed (drives the sidebar). */
  @Get('library')
  library(@CurrentUser() user: AuthUser) {
    return this.me.library(user);
  }

  @Get('saved')
  saved(@CurrentUser() user: AuthUser) {
    return this.me.savedListings(user);
  }

  @Put('saved/:listingId')
  @HttpCode(204)
  save(@CurrentUser() user: AuthUser, @Param('listingId') listingId: string) {
    return this.me.save(user, listingId);
  }

  @Delete('saved/:listingId')
  @HttpCode(204)
  unsave(@CurrentUser() user: AuthUser, @Param('listingId') listingId: string) {
    return this.me.unsave(user, listingId);
  }

  @Get('following')
  following(@CurrentUser() user: AuthUser) {
    return this.me.following(user);
  }

  @Put('following/:storefrontId')
  @HttpCode(204)
  follow(@CurrentUser() user: AuthUser, @Param('storefrontId') storefrontId: string) {
    return this.me.follow(user, storefrontId);
  }

  @Delete('following/:storefrontId')
  @HttpCode(204)
  unfollow(@CurrentUser() user: AuthUser, @Param('storefrontId') storefrontId: string) {
    return this.me.unfollow(user, storefrontId);
  }

  /** Record a visit for the "Recently viewed" shelf (keeps the latest 12). */
  @Post('recent')
  @HttpCode(204)
  recordView(@CurrentUser() user: AuthUser, @Body() dto: RecordViewDto) {
    return this.me.recordView(user, dto);
  }
}

@Module({
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
