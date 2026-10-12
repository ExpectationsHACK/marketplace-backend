import {
  Body,
  ConflictException,
  Controller,
  Delete,
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
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type { Prisma } from '../generated/prisma/client.js';
import { CurrentUser, RequireAuth, type AuthUser } from '../common/auth.js';
import { CURRENCIES } from '../common/categories.js';
import { IMAGE_URL_PATTERN, PageQueryDto, pageArgs } from '../common/dto.js';
import { isUniqueViolation } from '../common/errors.js';
import {
  productInclude,
  storefrontInclude,
  toProduct,
  toStorefront,
  type Page,
  type ProductDto,
  type StorefrontDto,
} from '../common/mappers.js';
import { normalizePhone } from '../common/phone.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { tokenize } from '../listings/listings.module.js';

const PHONE = /^\+?[\d\s()-]{9,20}$/;
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

// ------------------------------------------------------------------ DTOs

export class StorefrontQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;
}

export class CreateStorefrontDto {
  @IsString()
  @Length(2, 80)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  bio?: string;

  /** Where customer orders land, with country code. */
  @Matches(PHONE, { message: 'Enter the full WhatsApp number with country code' })
  whatsappNumber: string;

  /** e.g. "Fashion & Fabric" (see GET /categories/shops for suggestions). */
  @IsString()
  @Length(2, 60)
  category: string;

  /** e.g. "Lagos, Nigeria". */
  @IsString()
  @Length(2, 80)
  city: string;
}

export class UpdateStorefrontDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  bio?: string;

  @IsOptional()
  @Matches(PHONE, { message: 'Enter the full WhatsApp number with country code' })
  whatsappNumber?: string;

  @IsOptional()
  @IsString()
  @Length(2, 60)
  category?: string;

  @IsOptional()
  @IsString()
  @Length(2, 80)
  city?: string;

  @IsOptional()
  @Matches(IMAGE_URL_PATTERN)
  logoUrl?: string;

  @IsOptional()
  @Matches(IMAGE_URL_PATTERN)
  coverUrl?: string;

  /** e.g. "kwamesneaks.com". Empty string or null removes it. Saved as PENDING until DNS is verified. */
  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v !== null)
  @Matches(HOSTNAME, { message: 'Enter a domain like yourshop.com' })
  customDomain?: string | null;
}

export class CreateProductDto {
  @IsString()
  @Length(3, 80)
  title: string;

  /** Whole currency units. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price: number;

  @IsIn(CURRENCIES)
  currency: (typeof CURRENCIES)[number];

  @IsString()
  @Length(2, 40)
  category: string;

  @IsString()
  @Length(10, 2000)
  description: string;

  @IsOptional()
  @IsBoolean()
  inStock?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @Matches(IMAGE_URL_PATTERN, { each: true, message: 'Each image must be a path returned by POST /uploads' })
  images?: string[];
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @Length(3, 80)
  title?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: (typeof CURRENCIES)[number];

  @IsOptional()
  @IsString()
  @Length(2, 40)
  category?: string;

  @IsOptional()
  @IsString()
  @Length(10, 2000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  inStock?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @Matches(IMAGE_URL_PATTERN, { each: true, message: 'Each image must be a path returned by POST /uploads' })
  images?: string[];
}

// ------------------------------------------------------------------ service

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

@Injectable()
export class StorefrontsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: StorefrontQueryDto): Promise<Page<StorefrontDto>> {
    const where: Prisma.StorefrontWhereInput = {
      AND: [
        q.city ? { city: { contains: q.city } } : {},
        q.category ? { category: q.category } : {},
        ...tokenize(q.q).map((t) => ({
          OR: [{ name: { contains: t } }, { bio: { contains: t } }, { category: { contains: t } }, { city: { contains: t } }],
        })),
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.storefront.findMany({
        where,
        include: storefrontInclude,
        orderBy: [{ isVerified: 'desc' }, { followersCount: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.storefront.count({ where }),
    ]);
    return { items: rows.map(toStorefront), total, page: q.page, limit: q.limit };
  }

  async bySlug(slug: string): Promise<StorefrontDto> {
    const row = await this.prisma.storefront.findUnique({ where: { slug }, include: storefrontInclude });
    if (!row) throw new NotFoundException('Shop not found');
    return toStorefront(row);
  }

  async productsBySlug(slug: string): Promise<ProductDto[]> {
    const shop = await this.prisma.storefront.findUnique({ where: { slug }, select: { id: true } });
    if (!shop) throw new NotFoundException('Shop not found');
    const rows = await this.prisma.product.findMany({
      where: { storefrontId: shop.id },
      include: productInclude,
      orderBy: [{ inStock: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map(toProduct);
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name) || 'shop';
    const taken = new Set(
      (await this.prisma.storefront.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })).map((s) => s.slug),
    );
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  async create(user: AuthUser, dto: CreateStorefrontDto): Promise<StorefrontDto> {
    const existing = await this.prisma.storefront.findUnique({ where: { ownerId: user.id }, select: { slug: true } });
    if (existing) throw new ConflictException({ code: 'STOREFRONT_EXISTS', message: 'You already have a shop', slug: existing.slug });
    // The badge follows the person: an already-verified seller's new shop is verified too.
    const { verified } = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { verified: true } });
    try {
      const row = await this.prisma.storefront.create({
        data: {
          ownerId: user.id,
          isVerified: verified,
          slug: await this.uniqueSlug(dto.name),
          name: dto.name.trim(),
          bio: dto.bio?.trim() ?? '',
          whatsappNumber: normalizePhone(dto.whatsappNumber),
          category: dto.category.trim(),
          city: dto.city.trim(),
        },
        include: storefrontInclude,
      });
      return toStorefront(row);
    } catch (error) {
      // A double-submit, or two shops racing for one slug: say so instead of a 500.
      if (isUniqueViolation(error)) throw new ConflictException('That shop is already being created. Refresh to see it.');
      throw error;
    }
  }

  async ownedShop(user: AuthUser, id: string) {
    const shop = await this.prisma.storefront.findUnique({ where: { id }, select: { id: true, ownerId: true } });
    if (!shop) throw new NotFoundException('Shop not found');
    // Owners only: a shop's name and WhatsApp number are where buyers send money; no one else edits them.
    if (shop.ownerId !== user.id) throw new ForbiddenException('Only the shop owner can do this');
    return shop;
  }

  async update(user: AuthUser, id: string, dto: UpdateStorefrontDto): Promise<StorefrontDto> {
    await this.ownedShop(user, id);
    const { customDomain, whatsappNumber, ...rest } = dto;
    const domainPatch =
      customDomain === undefined
        ? {}
        : customDomain
          ? { customDomain: customDomain.toLowerCase(), domainStatus: 'PENDING' as const }
          : { customDomain: null, domainStatus: 'NONE' as const };
    try {
      const row = await this.prisma.storefront.update({
        where: { id },
        data: {
          ...rest,
          name: rest.name?.trim(),
          bio: rest.bio?.trim(),
          ...(whatsappNumber ? { whatsappNumber: normalizePhone(whatsappNumber) } : {}),
          ...domainPatch,
        },
        include: storefrontInclude,
      });
      return toStorefront(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('That domain is already reserved by another shop');
      throw error;
    }
  }

  async addProduct(user: AuthUser, storefrontId: string, dto: CreateProductDto): Promise<ProductDto> {
    await this.ownedShop(user, storefrontId);
    const row = await this.prisma.product.create({
      data: {
        storefrontId,
        title: dto.title.trim(),
        price: dto.price,
        currency: dto.currency,
        category: dto.category.trim(),
        description: dto.description.trim(),
        inStock: dto.inStock ?? true,
        images: { create: (dto.images ?? []).map((url, position) => ({ url, position })) },
      },
      include: productInclude,
    });
    return toProduct(row);
  }

  async getProduct(id: string): Promise<ProductDto> {
    const row = await this.prisma.product.findUnique({ where: { id }, include: productInclude });
    if (!row) throw new NotFoundException('Product not found');
    return toProduct(row);
  }

  private async ownedProduct(user: AuthUser, id: string) {
    const row = await this.prisma.product.findUnique({ where: { id }, select: { storefront: { select: { ownerId: true } } } });
    if (!row) throw new NotFoundException('Product not found');
    if (row.storefront.ownerId !== user.id) throw new ForbiddenException('Only the shop owner can do this');
  }

  async updateProduct(user: AuthUser, id: string, dto: UpdateProductDto): Promise<ProductDto> {
    await this.ownedProduct(user, id);
    const { images, ...fields } = dto;
    const row = await this.prisma.product.update({
      where: { id },
      data: {
        ...fields,
        title: fields.title?.trim(),
        description: fields.description?.trim(),
        ...(images ? { images: { deleteMany: {}, create: images.map((url, position) => ({ url, position })) } } : {}),
      },
      include: productInclude,
    });
    return toProduct(row);
  }

  async deleteProduct(user: AuthUser, id: string): Promise<void> {
    await this.ownedProduct(user, id);
    await this.prisma.product.delete({ where: { id } });
  }
}

// ------------------------------------------------------------------ controllers

@ApiTags('storefronts')
@Controller('storefronts')
export class StorefrontsController {
  constructor(private readonly shops: StorefrontsService) {}

  @Get()
  list(@Query() q: StorefrontQueryDto) {
    return this.shops.list(q);
  }

  /** A shop's public page, by its link slug (sokoni.africa/s/<slug>). */
  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.shops.bySlug(slug);
  }

  /** The shop's catalog, in-stock first. */
  @Get(':slug/products')
  products(@Param('slug') slug: string) {
    return this.shops.productsBySlug(slug);
  }

  /** Open a shop. One per seller. */
  @Post()
  @RequireAuth()
  @ApiBearerAuth()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStorefrontDto) {
    return this.shops.create(user, dto);
  }

  @Patch(':id')
  @RequireAuth()
  @ApiBearerAuth()
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateStorefrontDto) {
    return this.shops.update(user, id, dto);
  }

  @Post(':id/products')
  @RequireAuth()
  @ApiBearerAuth()
  addProduct(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateProductDto) {
    return this.shops.addProduct(user, id, dto);
  }
}

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(private readonly shops: StorefrontsService) {}

  @Get(':id')
  get(@Param('id') id: string) {
    return this.shops.getProduct(id);
  }

  /** Edit price, stock, details or photos. */
  @Patch(':id')
  @RequireAuth()
  @ApiBearerAuth()
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.shops.updateProduct(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireAuth()
  @ApiBearerAuth()
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.shops.deleteProduct(user, id);
  }
}

@Module({
  controllers: [StorefrontsController, ProductsController],
  providers: [StorefrontsService],
  exports: [StorefrontsService],
})
export class StorefrontsModule {}
