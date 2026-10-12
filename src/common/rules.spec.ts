import { validateEnv } from '../config/env.js';
import { sniff } from '../uploads/file-store.js';
import { tokenize } from '../listings/listings.module.js';
import { pickTopResult } from '../search/search.module.js';
import { slugify } from '../storefronts/storefronts.module.js';
import { effectiveStatus, type ListingDto, type PublicUser, type StorefrontDto } from './mappers.js';
import { isPlausiblePhone, normalizePhone } from './phone.js';

describe('phone numbers', () => {
  it('normalizes any formatting to +digits so one person has one account', () => {
    expect(normalizePhone('+234 802 314 8890')).toBe('+2348023148890');
    expect(normalizePhone('(+254) 711-000-005')).toBe('+254711000005');
  });

  it('rejects numbers too short or long to be real', () => {
    expect(isPlausiblePhone('+234 802')).toBe(false);
    expect(isPlausiblePhone('+234 802 314 8890')).toBe(true);
    expect(isPlausiblePhone('+1234567890123456')).toBe(false);
  });
});

describe('slugify', () => {
  it('makes URL-safe shop slugs', () => {
    expect(slugify('Amara Fabrics & Ankara')).toBe('amara-fabrics-ankara');
    expect(slugify('  Café Accra!  ')).toBe('cafe-accra');
  });
});

describe('tokenize', () => {
  it('splits on whitespace, lowercases and caps the word count', () => {
    expect(tokenize('  iPhone   LAGOS ')).toEqual(['iphone', 'lagos']);
    expect(tokenize(undefined)).toEqual([]);
    expect(tokenize('a b c d e f g h i j')).toHaveLength(8);
  });
});

describe('effectiveStatus', () => {
  const now = new Date('2026-10-11T12:00:00Z');

  it('reports an active listing past its expiry as EXPIRED', () => {
    expect(effectiveStatus({ status: 'ACTIVE', expiresAt: new Date('2026-10-01T00:00:00Z') }, now)).toBe('EXPIRED');
  });

  it('leaves live, undated and sold listings alone', () => {
    expect(effectiveStatus({ status: 'ACTIVE', expiresAt: new Date('2026-11-01T00:00:00Z') }, now)).toBe('ACTIVE');
    expect(effectiveStatus({ status: 'ACTIVE', expiresAt: null }, now)).toBe('ACTIVE');
    expect(effectiveStatus({ status: 'SOLD', expiresAt: new Date('2026-10-01T00:00:00Z') }, now)).toBe('SOLD');
  });
});

describe('pickTopResult', () => {
  const listing = (title: string) => ({ title }) as ListingDto;
  const shop = (name: string) => ({ name }) as StorefrontDto;
  const seller = (name: string) => ({ name }) as PublicUser;

  it('prefers a shop name, then a seller name, then a listing title', () => {
    expect(pickTopResult('kwame', [listing('Kwame sneakers')], [shop('Kwame Sneaks')], [seller('Kwame Mensah')])).toMatchObject({ kind: 'shop' });
    expect(pickTopResult('kwame', [listing('Kwame sneakers')], [], [seller('Kwame Mensah')])).toMatchObject({ kind: 'seller' });
    expect(pickTopResult('macbook', [listing('Desk'), listing('MacBook Air')], [], [])).toMatchObject({
      kind: 'listing',
      listing: { title: 'MacBook Air' },
    });
  });

  it('falls back to the first result, or null when nothing matched', () => {
    expect(pickTopResult('lagos', [listing('Desk')], [], [])).toMatchObject({ kind: 'listing', listing: { title: 'Desk' } });
    expect(pickTopResult('lagos', [], [], [])).toBeNull();
  });
});

describe('validateEnv', () => {
  const base = { DATABASE_URL: 'file:./dev.db', JWT_SECRET: 'x'.repeat(32) };

  it('fills defaults', () => {
    expect(validateEnv(base)).toMatchObject({ PORT: 4000, JWT_EXPIRES_IN: '7d', OTP_DEV_ECHO: false, PUBLIC_BASE_URL: 'http://localhost:4000' });
  });

  it('lists every problem at once', () => {
    const message = (() => {
      try {
        validateEnv({ JWT_SECRET: 'short' });
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('DATABASE_URL is required');
    expect(message).toContain('JWT_SECRET must be at least 32 characters');
  });

  it('refuses to echo OTP codes in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', OTP_DEV_ECHO: 'true' })).toThrow(/OTP_DEV_ECHO must be false/);
  });
});

describe('uploads config', () => {
  const base = { DATABASE_URL: 'file:./dev.db', JWT_SECRET: 'x'.repeat(32) };

  it('refuses a private folder that is, or sits inside, the public one', () => {
    expect(() => validateEnv({ ...base, UPLOAD_DIR: './uploads', PRIVATE_UPLOAD_DIR: './uploads' })).toThrow(/PRIVATE_UPLOAD_DIR/);
    expect(() => validateEnv({ ...base, UPLOAD_DIR: './uploads', PRIVATE_UPLOAD_DIR: './uploads/private' })).toThrow(/PRIVATE_UPLOAD_DIR/);
    expect(validateEnv({ ...base, UPLOAD_DIR: './uploads', PRIVATE_UPLOAD_DIR: './private-uploads' }).PRIVATE_UPLOAD_DIR).toBe('./private-uploads');
  });

  it('keeps the API docs off in production unless asked', () => {
    expect(validateEnv(base).SWAGGER_ENABLED).toBe(true);
    expect(validateEnv({ ...base, NODE_ENV: 'production' }).SWAGGER_ENABLED).toBe(false);
    expect(validateEnv({ ...base, NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED).toBe(true);
  });
});

describe('sniff', () => {
  it('trusts bytes, not names', () => {
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe('jpg');
    expect(sniff(Buffer.from('%PDF-1.7'))?.ext).toBe('pdf');
    expect(sniff(Buffer.from('<svg onload="alert(1)">'))).toBeNull();
    expect(sniff(Buffer.from('<html><script>'))).toBeNull();
  });
});
