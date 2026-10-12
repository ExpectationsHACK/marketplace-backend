// Response shapes. Field names follow the frontend's domain types
// (Monorepo frontend/src/lib/types.ts) so the UI's local stores can be
// swapped for these endpoints without reshaping data. Optional fields are
// omitted when absent, exactly as the frontend types declare them.

import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

// ---------------------------------------------------------------- includes

export const sellerSelect = {
  id: true,
  name: true,
  avatarUrl: true,
  verified: true,
  trustScore: true,
} satisfies Prisma.UserSelect;

export const listingInclude = {
  images: { orderBy: { position: 'asc' } },
  seller: { select: sellerSelect },
} satisfies Prisma.ListingInclude;

export const storefrontInclude = {
  products: { select: { id: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.StorefrontInclude;

export const productInclude = {
  images: { orderBy: { position: 'asc' } },
} satisfies Prisma.ProductInclude;

type UserRow = Prisma.UserGetPayload<object>;
type SellerRow = Prisma.UserGetPayload<{ select: typeof sellerSelect }>;
type ListingRow = Prisma.ListingGetPayload<{ include: typeof listingInclude }>;
type StorefrontRow = Prisma.StorefrontGetPayload<{ include: typeof storefrontInclude }>;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type MessageRow = Prisma.MessageGetPayload<object>;

// ---------------------------------------------------------------- shapes

export interface SellerSummary {
  id: string;
  name: string;
  avatarUrl?: string;
  verified: boolean;
  trustScore: number;
}

export interface PublicUser extends SellerSummary {
  /**
   * The WhatsApp contact buyers use. Only for people who sell (a shop or a
   * live listing): a buyer's number is never public. See sellerIdsAmong().
   */
  phone?: string;
  role: UserRow['role'];
  memberSince: string;
  responseTime?: string;
}

export interface MeUser extends PublicUser {
  phone: string;
  email?: string;
  phoneVerified: boolean;
}

export interface ListingDto {
  id: string;
  sellerId: string;
  category: ListingRow['category'];
  title: string;
  description: string;
  price?: number;
  currency: string;
  images: string[];
  location: { lat: number | null; lng: number | null; city: string; country: string };
  status: ListingRow['status'];
  createdAt: string;
  expiresAt?: string;
  featured: boolean;
  seller: SellerSummary;
}

export interface StorefrontDto {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  bio: string;
  logoUrl?: string;
  coverUrl?: string;
  whatsappNumber: string;
  category: string;
  city: string;
  isVerified: boolean;
  plan: StorefrontRow['plan'];
  productIds: string[];
  followers: number;
  responseRate: number;
  customDomain?: string;
  domainStatus: StorefrontRow['domainStatus'];
}

export interface ProductDto {
  id: string;
  storefrontId: string;
  title: string;
  price: number;
  currency: string;
  images: string[];
  inStock: boolean;
  category: string;
  description: string;
  createdAt: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

// ---------------------------------------------------------------- mappers

const opt = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

export function toSeller(u: SellerRow): SellerSummary {
  return { id: u.id, name: u.name, avatarUrl: opt(u.avatarUrl), verified: u.verified, trustScore: u.trustScore };
}

/** `showPhone`: true only for sellers (sellerIdsAmong), the person themselves, or moderators. */
export function toPublicUser(u: UserRow, showPhone: boolean): PublicUser {
  return {
    ...toSeller(u),
    phone: showPhone ? u.phone : undefined,
    role: u.role,
    memberSince: u.createdAt.toISOString(),
    responseTime: opt(u.responseTime),
  };
}

export function toMe(u: UserRow): MeUser {
  return { ...toPublicUser(u, true), phone: u.phone, email: opt(u.email), phoneVerified: u.phoneVerified };
}

/** An ACTIVE listing past its expiry reads as EXPIRED without a background job. */
export function effectiveStatus(l: { status: ListingRow['status']; expiresAt: Date | null }, now = new Date()) {
  return l.status === 'ACTIVE' && l.expiresAt && l.expiresAt < now ? 'EXPIRED' : l.status;
}

export function toListing(l: ListingRow): ListingDto {
  return {
    id: l.id,
    sellerId: l.sellerId,
    category: l.category,
    title: l.title,
    description: l.description,
    price: opt(l.price),
    currency: l.currency,
    images: l.images.map((i) => i.url),
    location: { lat: l.lat, lng: l.lng, city: l.city, country: l.country },
    status: effectiveStatus(l),
    createdAt: l.createdAt.toISOString(),
    expiresAt: l.expiresAt?.toISOString(),
    featured: l.featured,
    seller: toSeller(l.seller),
  };
}

export function toStorefront(s: StorefrontRow): StorefrontDto {
  return {
    id: s.id,
    ownerId: s.ownerId,
    slug: s.slug,
    name: s.name,
    bio: s.bio,
    logoUrl: opt(s.logoUrl),
    coverUrl: opt(s.coverUrl),
    whatsappNumber: s.whatsappNumber,
    category: s.category,
    city: s.city,
    isVerified: s.isVerified,
    plan: s.plan,
    productIds: s.products.map((p) => p.id),
    followers: s.followersCount,
    responseRate: s.responseRate,
    customDomain: opt(s.customDomain),
    domainStatus: s.domainStatus,
  };
}

export function toProduct(p: ProductRow): ProductDto {
  return {
    id: p.id,
    storefrontId: p.storefrontId,
    title: p.title,
    price: p.price,
    currency: p.currency,
    images: p.images.map((i) => i.url),
    inStock: p.inStock,
    category: p.category,
    description: p.description,
    createdAt: p.createdAt.toISOString(),
  };
}

export function toMessage(m: MessageRow): MessageDto {
  return { id: m.id, conversationId: m.conversationId, senderId: m.senderId, body: m.body, createdAt: m.createdAt.toISOString() };
}

/** Public feeds: live and not past expiry. */
export function liveListingWhere(now = new Date()): Prisma.ListingWhereInput {
  return { status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

/** Who among these people sells (runs a shop or has a live listing), and so has a public WhatsApp number. */
export async function sellerIdsAmong(prisma: Pick<PrismaClient, 'user'>, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await prisma.user.findMany({
    where: { id: { in: ids }, OR: [{ storefront: { isNot: null } }, { listings: { some: liveListingWhere() } }] },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}
