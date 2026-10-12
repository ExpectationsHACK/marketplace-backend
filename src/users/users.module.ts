import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, RequireAuth, type AuthUser } from '../common/auth.js';
import { isUniqueViolation } from '../common/errors.js';
import {
  listingInclude,
  liveListingWhere,
  sellerSelect,
  storefrontInclude,
  toListing,
  sellerIdsAmong,
  toPublicUser,
  toSeller,
  toStorefront,
  type PublicUser,
  type SellerSummary,
} from '../common/mappers.js';
import { PrismaService } from '../prisma/prisma.service.js';

export class CreateReviewDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  comment?: string;
}

export interface ReviewDto {
  id: string;
  fromUserId: string;
  toUserId: string;
  rating: number;
  comment?: string;
  createdAt: string;
  from: SellerSummary;
}

export interface ProfileDto extends PublicUser {
  rating: number;
  reviewCount: number;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  private async exists(id: string) {
    const found = await this.prisma.user.count({ where: { id } });
    if (!found) throw new NotFoundException('User not found');
  }

  async profile(id: string): Promise<ProfileDto> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    const [agg, sellers] = await Promise.all([
      this.prisma.review.aggregate({ where: { toUserId: id }, _avg: { rating: true }, _count: true }),
      sellerIdsAmong(this.prisma, [id]),
    ]);
    return {
      ...toPublicUser(user, sellers.has(id)),
      rating: Math.round((agg._avg.rating ?? 0) * 10) / 10,
      reviewCount: agg._count,
    };
  }

  async listings(id: string) {
    await this.exists(id);
    const rows = await this.prisma.listing.findMany({
      where: { AND: [liveListingWhere(), { sellerId: id }] },
      include: listingInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toListing);
  }

  async storefront(id: string) {
    const row = await this.prisma.storefront.findUnique({ where: { ownerId: id }, include: storefrontInclude });
    if (!row) throw new NotFoundException('This person has no shop');
    return toStorefront(row);
  }

  async reviews(id: string): Promise<ReviewDto[]> {
    await this.exists(id);
    const rows = await this.prisma.review.findMany({
      where: { toUserId: id },
      include: { from: { select: sellerSelect } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      fromUserId: r.fromUserId,
      toUserId: r.toUserId,
      rating: r.rating,
      comment: r.comment ?? undefined,
      createdAt: r.createdAt.toISOString(),
      from: toSeller(r.from),
    }));
  }

  async review(author: AuthUser, toUserId: string, dto: CreateReviewDto) {
    if (author.id === toUserId) throw new BadRequestException("You can't review yourself");
    await this.exists(toUserId);
    try {
      await this.prisma.review.create({
        data: { fromUserId: author.id, toUserId, rating: dto.rating, comment: dto.comment?.trim() },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('You have already reviewed this seller');
      throw error;
    }
    return (await this.reviews(toUserId)).find((r) => r.fromUserId === author.id)!;
  }
}

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Public profile with rating summary. */
  @Get(':id')
  profile(@Param('id') id: string) {
    return this.users.profile(id);
  }

  /** The person's live listings. */
  @Get(':id/listings')
  listings(@Param('id') id: string) {
    return this.users.listings(id);
  }

  @Get(':id/storefront')
  storefront(@Param('id') id: string) {
    return this.users.storefront(id);
  }

  @Get(':id/reviews')
  reviews(@Param('id') id: string) {
    return this.users.reviews(id);
  }

  /** Leave a review. One per reviewer per seller. */
  @Post(':id/reviews')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequireAuth()
  @ApiBearerAuth()
  review(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateReviewDto) {
    return this.users.review(user, id, dto);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
