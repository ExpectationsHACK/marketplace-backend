import type { Category } from '../generated/prisma/enums.js';

/** Display metadata for listing categories; same values the frontend renders. */
export const CATEGORY_META: Record<Category, { label: string; blurb: string; color: string }> = {
  FOR_SALE: { label: 'For Sale', blurb: 'Electronics, vehicles, furniture & more', color: '#e13300' },
  HOUSING: { label: 'Housing', blurb: 'Rentals, shortlets & land', color: '#1e3264' },
  JOBS: { label: 'Jobs', blurb: 'Full-time, part-time & hiring posts', color: '#8400e7' },
  SERVICES: { label: 'Services', blurb: 'Book trusted local professionals', color: '#27856a' },
  GIGS: { label: 'Gigs', blurb: 'One-off tasks & quick errands', color: '#dc148c' },
  COMMUNITY: { label: 'Community', blurb: 'Free stuff, events & announcements', color: '#477d95' },
};

export const CATEGORIES = Object.keys(CATEGORY_META) as Category[];

/** Shop categories offered during onboarding (free text in the DB, suggested in the UI). */
export const SHOP_CATEGORIES = [
  'Fashion & Fabric',
  'Beauty & Wellness',
  'Sneakers & Streetwear',
  'Electronics',
  'Food & Groceries',
  'Home & Living',
] as const;

export const CURRENCIES = ['NGN', 'GHS', 'KES', 'UGX'] as const;
