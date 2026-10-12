import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Category } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { CurrentUser, RequireAuth, type AuthUser } from '../common/auth.js';
import { CATEGORY_META, CURRENCIES } from '../common/categories.js';
import { IMAGE_URL_PATTERN, PageQueryDto, pageArgs } from '../common/dto.js';
import { isUniqueViolation } from '../common/errors.js';
import { listingInclude, liveListingWhere, toListing, type ListingDto, type Page } from '../common/mappers.js';
import { PrismaService } from '../prisma/prisma.service.js';

const LISTING_TTL_DAYS = 30;
const toBool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

// ------------------------------------------------------------------ DTOs

export class ListingQueryDto extends PageQueryDto {
  @IsOptional()
  @IsEnum(Category)
  category?: Category;

  /** Exact city, e.g. "Lagos". */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;

  /** Words to match in title, description, location, category or seller name. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Only listings from ID-verified sellers. */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  verifiedOnly?: boolean;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  featured?: boolean;

  @IsOptional()
  @IsString()
  sellerId?: string;

  @IsOptional()
  @IsIn(['newest', 'price-asc', 'price-desc', 'trust'])
  sort: 'newest' | 'price-asc' | 'price-desc' | 'trust' = 'newest';
}

export class CreateListingDto {
  @IsEnum(Category)
  category: Category;

  @IsString()
  @Length(3, 80)
  title: string;

  @IsString()
  @Length(10, 4000)
  description: string;

  /** Whole currency units. Omit (or null) for "contact for price". */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price?: number | null;

  @IsIn(CURRENCIES)
  currency: (typeof CURRENCIES)[number];

  @IsString()
  @Length(2, 60)
  city: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @IsOptional()
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @IsLongitude()
  lng?: number;

  /** Image URLs from POST /uploads, in display order (max 8). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @Matches(IMAGE_URL_PATTERN, { each: true, message: 'Each image must be a path returned by POST /uploads' })
  images?: string[];
}

export class UpdateListingDto {
  @IsOptional()
  @IsEnum(Category)
  category?: Category;

  @IsOptional()
  @IsString()
  @Length(3, 80)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(10, 4000)
  description?: string;

  /** Send null to switch to "contact for price". */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price?: number | null;

  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: (typeof CURRENCIES)[number];

  @IsOptional()
  @IsString()
  @Length(2, 60)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @Matches(IMAGE_URL_PATTERN, { each: true, message: 'Each image must be a path returned by POST /uploads' })
  images?: string[];

  /** ACTIVE to relist, SOLD to mark sold, REMOVED to take down. */
  @IsOptional()
  @IsIn(['ACTIVE', 'SOLD', 'REMOVED'])
  status?: 'ACTIVE' | 'SOLD' | 'REMOVED';
}

export class ReportListingDto {
  @IsIn(['scam', 'prohibited', 'wrong-category', 'duplicate', 'offensive', 'other'])
  reason: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  details?: string;
}

// ------------------------------------------------------------------ service

export function tokenize(q?: string): string[] {
  return (q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

/** Every word must appear somewhere: title, description, place, category label or seller name. */
export function listingTextWhere(tokens: string[]): Prisma.ListingWhereInput[] {
  return tokens.map((t) => {
    const cats = (Object.keys(CATEGORY_META) as Category[]).filter((c) => CATEGORY_META[c].label.toLowerCase().includes(t));
    return {
      OR: [
        { title: { contains: t } },
        { description: { contains: t } },
        { city: { contains: t } },
        { country: { contains: t } },
        { seller: { name: { contains: t } } },
        ...(cats.length ? [{ category: { in: cats } }] : []),
      ],
    };
  });
}

@Injectable()
export class ListingsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ListingQueryDto): Promise<Page<ListingDto>> {
    const where: Prisma.ListingWhereInput = {
      AND: [
        liveListingWhere(),
        q.category ? { category: q.category } : {},
        q.city ? { city: q.city } : {},
        q.sellerId ? { sellerId: q.sellerId } : {},
        q.featured !== undefined ? { featured: q.featured } : {},
        q.verifiedOnly ? { seller: { verified: true } } : {},
        ...listingTextWhere(tokenize(q.q)),
      ],
    };
    const orderBy: Prisma.ListingOrderByWithRelationInput[] =
      q.sort === 'price-asc'
        ? [{ price: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }]
        : q.sort === 'price-desc'
          ? [{ price: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
          : q.sort === 'trust'
            ? [{ seller: { trustScore: 'desc' } }, { createdAt: 'desc' }]
            : [{ createdAt: 'desc' }];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.listing.findMany({ where, orderBy, include: listingInclude, ...pageArgs(q) }),
      this.prisma.listing.count({ where }),
    ]);
    return { items: rows.map(toListing), total, page: q.page, limit: q.limit };
  }

  /** Taken-down listings are visible only to their seller (and moderators). */
  async get(id: string, viewer?: AuthUser): Promise<ListingDto> {
    const row = await this.prisma.listing.findUnique({ where: { id }, include: listingInclude });
    const privileged = viewer && (viewer.id === row?.sellerId || viewer.role !== 'USER');
    if (!row || (row.status === 'REMOVED' && !privileged)) throw new NotFoundException('Listing not found');
    return toListing(row);
  }

  async related(id: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id }, select: { sellerId: true, category: true } });
    if (!listing) throw new NotFoundException('Listing not found');
    const [moreFromSeller, sameCategory] = await Promise.all([
      this.prisma.listing.findMany({
        where: { AND: [liveListingWhere(), { sellerId: listing.sellerId, id: { not: id } }] },
        include: listingInclude,
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      this.prisma.listing.findMany({
        where: { AND: [liveListingWhere(), { category: listing.category, sellerId: { not: listing.sellerId } }] },
        include: listingInclude,
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
    ]);
    return { moreFromSeller: moreFromSeller.map(toListing), sameCategory: sameCategory.map(toListing) };
  }

  async create(user: AuthUser, dto: CreateListingDto): Promise<ListingDto> {
    const row = await this.prisma.listing.create({
      data: {
        sellerId: user.id,
        category: dto.category,
        title: dto.title.trim(),
        description: dto.description.trim(),
        price: dto.price ?? null,
        currency: dto.currency,
        city: dto.city.trim(),
        country: dto.country?.trim() ?? '',
        lat: dto.lat,
        lng: dto.lng,
        expiresAt: new Date(Date.now() + LISTING_TTL_DAYS * 86_400_000),
        images: { create: (dto.images ?? []).map((url, position) => ({ url, position })) },
      },
      include: listingInclude,
    });
    return toListing(row);
  }

  /**
   * The seller may change their own listing, unless a moderator took it down.
   * Moderators may only take listings down or put them back (status), never
   * rewrite what a seller said.
   */
  private async access(user: AuthUser, id: string): Promise<'seller' | 'moderator'> {
    const row = await this.prisma.listing.findUnique({ where: { id }, select: { sellerId: true, takenDownAt: true } });
    if (!row) throw new NotFoundException('Listing not found');
    if (row.sellerId === user.id) {
      if (row.takenDownAt) throw new ForbiddenException("Sokoni's trust team took this listing down, so it can't be changed or relisted");
      return 'seller';
    }
    if (user.role === 'USER') throw new ForbiddenException('Only the seller can change this listing');
    return 'moderator';
  }

  async update(user: AuthUser, id: string, dto: UpdateListingDto): Promise<ListingDto> {
    const role = await this.access(user, id);
    const { images, ...fields } = dto;
    if (role === 'moderator') {
      // DTO instances carry every declared field (undefined when not sent), so test values, not keys.
      if (Object.entries(dto).some(([k, v]) => k !== 'status' && v !== undefined) || !dto.status) {
        throw new ForbiddenException('Moderators can only take a listing down or restore it (status)');
      }
      const row = await this.prisma.listing.update({
        where: { id },
        data:
          dto.status === 'REMOVED'
            ? { status: 'REMOVED', takenDownAt: new Date() }
            : { status: dto.status, takenDownAt: null },
        include: listingInclude,
      });
      return toListing(row);
    }
    const row = await this.prisma.listing.update({
      where: { id },
      data: {
        ...fields,
        title: fields.title?.trim(),
        description: fields.description?.trim(),
        city: fields.city?.trim(),
        // undefined = not sent (keep the price); null = switch to contact for price.
        ...(dto.price !== undefined ? { price: dto.price } : {}),
        // Relisting a sold or removed item gives it a fresh 30 days.
        ...(dto.status === 'ACTIVE' ? { expiresAt: new Date(Date.now() + LISTING_TTL_DAYS * 86_400_000) } : {}),
        ...(images ? { images: { deleteMany: {}, create: images.map((url, position) => ({ url, position })) } } : {}),
      },
      include: listingInclude,
    });
    return toListing(row);
  }

  /** Live again for 30 days and back at the top of "Just listed". The seller's call only. */
  async renew(user: AuthUser, id: string): Promise<ListingDto> {
    if ((await this.access(user, id)) !== 'seller') throw new ForbiddenException('Only the seller can renew this listing');
    const now = new Date();
    const row = await this.prisma.listing.update({
      where: { id },
      data: { status: 'ACTIVE', createdAt: now, expiresAt: new Date(now.getTime() + LISTING_TTL_DAYS * 86_400_000) },
      include: listingInclude,
    });
    return toListing(row);
  }

  async report(user: AuthUser, id: string, dto: ReportListingDto) {
    const listing = await this.prisma.listing.findUnique({ where: { id }, select: { sellerId: true } });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.sellerId === user.id) throw new BadRequestException("You can't report your own listing");
    try {
      await this.prisma.report.create({ data: { listingId: id, reporterId: user.id, reason: dto.reason, details: dto.details } });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('You already reported this listing');
      throw error;
    }
    return { reported: true };
  }
}

// ------------------------------------------------------------------ controller

@ApiTags('listings')
@Controller('listings')
export class ListingsController {
  constructor(private readonly listings: ListingsService) {}

  /** Live listings with filters, search words and sorting. */
  @Get()
  list(@Query() q: ListingQueryDto) {
    return this.listings.list(q);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user?: AuthUser) {
    return this.listings.get(id, user);
  }

  /** "More from this seller" and "More in this category" shelves. */
  @Get(':id/related')
  related(@Param('id') id: string) {
    return this.listings.related(id);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequireAuth()
  @ApiBearerAuth()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateListingDto) {
    return this.listings.create(user, dto);
  }

  @Patch(':id')
  @RequireAuth()
  @ApiBearerAuth()
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateListingDto) {
    return this.listings.update(user, id, dto);
  }

  @Post(':id/renew')
  @HttpCode(200)
  @RequireAuth()
  @ApiBearerAuth()
  renew(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.listings.renew(user, id);
  }

  @Post(':id/reports')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequireAuth()
  @ApiBearerAuth()
  report(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReportListingDto) {
    return this.listings.report(user, id, dto);
  }
}

@Module({
  controllers: [ListingsController],
  providers: [ListingsService],
  exports: [ListingsService],
})
export class ListingsModule {}
