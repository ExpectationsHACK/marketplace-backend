// Seeds the database with the same fictional demo data the frontend ships
// (extracted from Monorepo frontend/src/lib/mock-data.ts into seed-data.json).
// Ids are kept identical (u1, s1, l1, …) so frontend URLs keep working.
// Idempotent: wipes the demo tables first. Never run against production.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { Category, ListingStatus, Plan, Role } from '../src/generated/prisma/enums.js';
import { normalizePhone } from '../src/common/phone.js';

interface SeedData {
  users: {
    id: string;
    name: string;
    phone: string;
    email?: string;
    verified: boolean;
    trustScore: number;
    role: Role;
    memberSince: string;
    responseTime?: string;
  }[];
  storefronts: {
    id: string;
    ownerId: string;
    slug: string;
    name: string;
    bio: string;
    whatsappNumber: string;
    category: string;
    city: string;
    isVerified: boolean;
    plan: Plan;
    followers: number;
    responseRate: number;
  }[];
  products: {
    id: string;
    storefrontId: string;
    title: string;
    price: number;
    currency: string;
    inStock: boolean;
    category: string;
    description: string;
    createdAt: string;
  }[];
  listings: {
    id: string;
    sellerId: string;
    category: Category;
    title: string;
    description: string;
    price?: number;
    currency: string;
    location: { lat: number; lng: number; city: string; country: string };
    status: ListingStatus;
    createdAt: string;
    featured?: boolean;
  }[];
  reviews: { id: string; fromUserId: string; toUserId: string; rating: number; comment?: string; createdAt: string }[];
  conversations: {
    id: string;
    listingId?: string;
    participantIds: string[];
    messages: { id: string; senderId: string; body: string; createdAt: string }[];
  }[];
}

const data = JSON.parse(readFileSync(new URL('./seed-data.json', import.meta.url), 'utf8')) as SeedData;
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! }) });

async function main() {
  // Children first.
  await prisma.$transaction([
    prisma.report.deleteMany(),
    prisma.otpCode.deleteMany(),
    prisma.verification.deleteMany(),
    prisma.recentView.deleteMany(),
    prisma.follow.deleteMany(),
    prisma.savedListing.deleteMany(),
    prisma.message.deleteMany(),
    prisma.conversationParticipant.deleteMany(),
    prisma.conversation.deleteMany(),
    prisma.review.deleteMany(),
    prisma.listingImage.deleteMany(),
    prisma.listing.deleteMany(),
    prisma.productImage.deleteMany(),
    prisma.product.deleteMany(),
    prisma.storefront.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  for (const u of data.users) {
    await prisma.user.create({
      data: {
        id: u.id,
        name: u.name,
        phone: normalizePhone(u.phone),
        email: u.email,
        verified: u.verified,
        phoneVerified: true,
        trustScore: u.trustScore,
        role: u.role,
        responseTime: u.responseTime,
        createdAt: new Date(u.memberSince),
        verification: u.verified
          ? { create: { status: 'APPROVED', submittedAt: new Date(u.memberSince), reviewedAt: new Date(u.memberSince) } }
          : undefined,
      },
    });
  }

  for (const s of data.storefronts) {
    await prisma.storefront.create({
      data: {
        id: s.id,
        ownerId: s.ownerId,
        slug: s.slug,
        name: s.name,
        bio: s.bio,
        whatsappNumber: normalizePhone(s.whatsappNumber),
        category: s.category,
        city: s.city,
        isVerified: s.isVerified,
        plan: s.plan,
        followersCount: s.followers,
        responseRate: s.responseRate,
      },
    });
  }

  for (const p of data.products) {
    await prisma.product.create({
      data: {
        id: p.id,
        storefrontId: p.storefrontId,
        title: p.title,
        price: p.price,
        currency: p.currency,
        inStock: p.inStock,
        category: p.category,
        description: p.description,
        createdAt: new Date(p.createdAt),
      },
    });
  }

  for (const l of data.listings) {
    await prisma.listing.create({
      data: {
        id: l.id,
        sellerId: l.sellerId,
        category: l.category,
        title: l.title,
        description: l.description,
        price: l.price ?? null,
        currency: l.currency,
        city: l.location.city,
        country: l.location.country,
        lat: l.location.lat,
        lng: l.location.lng,
        status: l.status,
        featured: l.featured ?? false,
        createdAt: new Date(l.createdAt),
      },
    });
  }

  for (const r of data.reviews) {
    await prisma.review.create({
      data: {
        id: r.id,
        fromUserId: r.fromUserId,
        toUserId: r.toUserId,
        rating: r.rating,
        comment: r.comment,
        createdAt: new Date(r.createdAt),
      },
    });
  }

  for (const c of data.conversations) {
    const last = c.messages.at(-1);
    await prisma.conversation.create({
      data: {
        id: c.id,
        listingId: c.listingId,
        lastMessageAt: last ? new Date(last.createdAt) : new Date(),
        participants: { create: c.participantIds.map((userId) => ({ userId })) },
        messages: {
          create: c.messages.map((m) => ({ id: m.id, senderId: m.senderId, body: m.body, createdAt: new Date(m.createdAt) })),
        },
      },
    });
  }

  // The demo user's starting library, matching the frontend's library-store defaults.
  await prisma.savedListing.createMany({
    data: [
      { userId: 'u1', listingId: 'l8', createdAt: new Date('2026-09-01T10:00:00Z') },
      { userId: 'u1', listingId: 'l4', createdAt: new Date('2026-08-24T18:30:00Z') },
    ],
  });
  await prisma.follow.createMany({
    data: [
      { userId: 'u1', storefrontId: 's2', createdAt: new Date('2026-07-02T09:00:00Z') },
      { userId: 'u1', storefrontId: 's3', createdAt: new Date('2026-06-11T12:00:00Z') },
    ],
  });

  const counts = await Promise.all([
    prisma.user.count(),
    prisma.storefront.count(),
    prisma.product.count(),
    prisma.listing.count(),
    prisma.review.count(),
    prisma.conversation.count(),
    prisma.message.count(),
  ]);
  console.log(`Seeded users=${counts[0]} shops=${counts[1]} products=${counts[2]} listings=${counts[3]} reviews=${counts[4]} conversations=${counts[5]} messages=${counts[6]}`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
