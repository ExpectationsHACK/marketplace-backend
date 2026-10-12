import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Category } from '../generated/prisma/enums.js';
import { CATEGORIES, CATEGORY_META, SHOP_CATEGORIES } from '../common/categories.js';
import {
  listingInclude,
  liveListingWhere,
  storefrontInclude,
  toListing,
  toPublicUser,
  toStorefront,
  type ListingDto,
  type PublicUser,
  type StorefrontDto,
} from '../common/mappers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { listingTextWhere, tokenize } from '../listings/listings.module.js';

export class SearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(['all', 'listings', 'shops', 'sellers'])
  type: 'all' | 'listings' | 'shops' | 'sellers' = 'all';
}

export type TopResult =
  | { kind: 'listing'; listing: ListingDto }
  | { kind: 'shop'; shop: StorefrontDto }
  | { kind: 'seller'; user: PublicUser };

export interface SearchResult {
  q: string;
  type: SearchQueryDto['type'];
  topResult: TopResult | null;
  listings: ListingDto[];
  shops: StorefrontDto[];
  sellers: PublicUser[];
}

const LIMIT = 30;

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search({ q = '', type }: SearchQueryDto): Promise<SearchResult> {
    const tokens = tokenize(q);
    const want = (t: SearchQueryDto['type']) => type === 'all' || type === t;

    const [listingRows, shopRows, userRows] = await Promise.all([
      want('listings')
        ? this.prisma.listing.findMany({
            where: { AND: [liveListingWhere(), ...listingTextWhere(tokens)] },
            include: listingInclude,
            orderBy: { createdAt: 'desc' },
            take: LIMIT,
          })
        : [],
      want('shops')
        ? this.prisma.storefront.findMany({
            where: {
              AND: tokens.map((t) => ({
                OR: [{ name: { contains: t } }, { bio: { contains: t } }, { category: { contains: t } }, { city: { contains: t } }],
              })),
            },
            include: storefrontInclude,
            orderBy: { followersCount: 'desc' },
            take: LIMIT,
          })
        : [],
      // Sellers = people with a live listing or a shop.
      want('sellers')
        ? this.prisma.user.findMany({
            where: {
              AND: [
                { OR: [{ storefront: { isNot: null } }, { listings: { some: liveListingWhere() } }] },
                ...tokens.map((t) => ({ name: { contains: t } })),
              ],
            },
            orderBy: { trustScore: 'desc' },
            take: LIMIT,
          })
        : [],
    ]);

    const listings = listingRows.map(toListing);
    const shops = shopRows.map(toStorefront);
    // Everyone here sells (a shop or a live listing), so their WhatsApp number is public.
    const sellers = userRows.map((u) => toPublicUser(u, true));
    return { q, type, topResult: q ? pickTopResult(q, listings, shops, sellers) : null, listings, shops, sellers };
  }
}

/** Prefer a name hit (shop, then seller), then a title hit, then the first listing. Same rule as the UI. */
export function pickTopResult(q: string, listings: ListingDto[], shops: StorefrontDto[], sellers: PublicUser[]): TopResult | null {
  const needle = q.toLowerCase().trim();
  const shop = shops.find((s) => s.name.toLowerCase().includes(needle));
  if (shop) return { kind: 'shop', shop };
  const seller = sellers.find((u) => u.name.toLowerCase().includes(needle));
  if (seller) return { kind: 'seller', user: seller };
  const titled = listings.find((l) => l.title.toLowerCase().includes(needle));
  if (titled) return { kind: 'listing', listing: titled };
  if (listings[0]) return { kind: 'listing', listing: listings[0] };
  if (shops[0]) return { kind: 'shop', shop: shops[0] };
  if (sellers[0]) return { kind: 'seller', user: sellers[0] };
  return null;
}

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /** Word-based search across listings, shops and sellers (every word must match). */
  @Get()
  search(@Query() q: SearchQueryDto) {
    return this.searchService.search(q);
  }
}

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  /** Listing categories with display metadata, live listing counts, and the cities they're in (for filter chips). */
  @Get()
  async list() {
    const rows = await this.prisma.listing.groupBy({ by: ['category', 'city'], where: liveListingWhere(), _count: true });
    return CATEGORIES.map((key: Category) => {
      const mine = rows.filter((r) => r.category === key);
      return {
        key,
        ...CATEGORY_META[key],
        liveCount: mine.reduce((sum, r) => sum + r._count, 0),
        cities: mine.map((r) => r.city).sort((a, b) => a.localeCompare(b)),
      };
    });
  }

  /** Suggested shop categories for onboarding. */
  @Get('shops')
  shopCategories() {
    return SHOP_CATEGORIES;
  }
}

@Module({
  controllers: [SearchController, CategoriesController],
  providers: [SearchService],
})
export class SearchModule {}
