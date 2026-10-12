import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: NestExpressApplication;
let prisma: PrismaService;
const api = () => request(app.getHttpServer() as App);

type Session = { token: string; user: { id: string }; isNewUser: boolean };
const sessions = new Map<string, Session>();

/**
 * Signs in via the real OTP flow (dev echo returns the code). Sessions are
 * reused per phone because the API enforces a 30s resend cooldown per number.
 */
async function signIn(phone: string, name?: string): Promise<Session> {
  const cached = sessions.get(phone);
  if (cached) return { ...cached, isNewUser: false };
  const sent = await api().post('/api/auth/otp/request').send({ phone }).expect(200);
  const res = await api().post('/api/auth/otp/verify').send({ phone, code: sent.body.devCode, name }).expect(200);
  const session = { token: res.body.accessToken as string, user: res.body.user, isNewUser: res.body.isNewUser as boolean };
  sessions.set(phone, session);
  return session;
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
/** A well-formed photo path, as POST /uploads returns (the file needn't exist to be referenced). */
const PHOTO = '/uploads/0b7d6a3e-1c2f-4a5b-9c8d-7e6f5a4b3c2d.jpg';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d00000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n% test document\n');

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app.close();
});

describe('public reads', () => {
  it('health checks the database', async () => {
    const res = await api().get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('lists live listings with filters and sorting', async () => {
    const res = await api().get('/api/listings').query({ category: 'FOR_SALE', sort: 'price-asc' }).expect(200);
    expect(res.body.total).toBe(4);
    const prices = res.body.items.map((l: { price: number }) => l.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(res.body.items[0].seller).toMatchObject({ name: expect.any(String), trustScore: expect.any(Number) });

    const verified = await api().get('/api/listings').query({ category: 'FOR_SALE', verifiedOnly: 'true' }).expect(200);
    expect(verified.body.items.every((l: { seller: { verified: boolean } }) => l.seller.verified)).toBe(true);
    expect(verified.body.total).toBe(3);
  });

  it('rejects unknown query parameters', async () => {
    await api().get('/api/listings').query({ colour: 'red' }).expect(400);
  });

  it('returns a listing, related shelves, and 404s', async () => {
    const res = await api().get('/api/listings/l1').expect(200);
    expect(res.body).toMatchObject({ id: 'l1', title: expect.stringContaining('iPhone'), location: { city: 'Lagos' } });
    expect(res.body).not.toHaveProperty('expiresAt');
    const related = await api().get('/api/listings/l1/related').expect(200);
    expect(related.body.moreFromSeller.every((l: { sellerId: string }) => l.sellerId === 'u4')).toBe(true);
    await api().get('/api/listings/nope').expect(404);
  });

  it('searches every word across listings, shops and sellers', async () => {
    const res = await api().get('/api/search').query({ q: 'iphone lagos' }).expect(200);
    expect(res.body.listings.map((l: { id: string }) => l.id)).toEqual(['l1']);
    expect(res.body.topResult).toMatchObject({ kind: 'listing' });
    const shop = await api().get('/api/search').query({ q: 'kwame' }).expect(200);
    expect(shop.body.topResult).toMatchObject({ kind: 'shop', shop: { slug: 'kwame-sneaks' } });
  });

  it('serves shops, catalogs, profiles and categories', async () => {
    const shop = await api().get('/api/storefronts/amara-fabrics').expect(200);
    expect(shop.body.followers).toBe(4218);
    expect([...shop.body.productIds].sort((a: string, b: string) => a.localeCompare(b))).toEqual(['p1', 'p2', 'p3', 'p4']);
    const products = await api().get('/api/storefronts/amara-fabrics/products').expect(200);
    expect(products.body.at(-1).inStock).toBe(false);
    const profile = await api().get('/api/users/u1').expect(200);
    expect(profile.body).toMatchObject({ name: 'Amara Chukwu', reviewCount: 2, rating: 5 });
    expect(profile.body).not.toHaveProperty('email');
    const cats = await api().get('/api/categories').expect(200);
    expect(cats.body.find((c: { key: string }) => c.key === 'FOR_SALE').liveCount).toBe(4);
  });
});

describe('auth', () => {
  it('needs a name for a new account, then signs in', async () => {
    const phone = '+254 700 000 001';
    const sent = await api().post('/api/auth/otp/request').send({ phone }).expect(200);
    expect(sent.body).toMatchObject({ sent: true, devCode: expect.stringMatching(/^\d{6}$/) });

    // A wrong code can't be used to learn whether a number has an account.
    const wrong = sent.body.devCode === '111111' ? '222222' : '111111';
    await api().post('/api/auth/otp/verify').send({ phone, code: wrong }).expect(400);
    const noName = await api().post('/api/auth/otp/verify').send({ phone, code: sent.body.devCode }).expect(422);
    expect(noName.body.code).toBe('NAME_REQUIRED');
    await api().post('/api/auth/otp/verify').send({ phone, code: '000000', name: 'Test' }).expect(400);

    const ok = await api().post('/api/auth/otp/verify').send({ phone, code: sent.body.devCode, name: 'Achieng Test' }).expect(200);
    sessions.set(phone, { token: ok.body.accessToken, user: ok.body.user, isNewUser: false });
    expect(ok.body).toMatchObject({ tokenType: 'Bearer', isNewUser: true, user: { phone: '+254700000001', phoneVerified: true } });
    await api().post('/api/auth/otp/verify').send({ phone, code: sent.body.devCode }).expect(400); // single use
  });

  it('blocks protected routes without a valid token', async () => {
    await api().get('/api/me').expect(401);
    await api().get('/api/me').set(bearer('not-a-token')).expect(401);
  });

  it('signs a seeded seller back in', async () => {
    const amara = await signIn('+234 802 314 8890');
    expect(amara.isNewUser).toBe(false);
    const me = await api().get('/api/me').set(bearer(amara.token)).expect(200);
    expect(me.body).toMatchObject({ id: 'u1', email: 'amara@amarafabrics.ng' });
  });
});

describe('selling', () => {
  let seller: { token: string; user: { id: string } };
  let other: { token: string };
  let listingId: string;

  beforeAll(async () => {
    seller = await signIn('+233 20 000 0002', 'Kofi Seller');
    other = await signIn('+233 20 000 0003', 'Esi Other');
  });

  it('posts, edits, marks sold, renews', async () => {
    await api().post('/api/listings').send({}).expect(401);
    await api()
      .post('/api/listings')
      .set(bearer(seller.token))
      .send({ category: 'FOR_SALE', title: 'X', description: 'short', currency: 'USD', city: 'A' })
      .expect(400);

    const created = await api()
      .post('/api/listings')
      .set(bearer(seller.token))
      .send({
        category: 'FOR_SALE',
        title: 'Samsung Galaxy S23, 128GB',
        description: 'Lightly used for 8 months, with charger and case.',
        price: 420000,
        currency: 'NGN',
        city: 'Lagos',
        images: [PHOTO],
      })
      .expect(201);
    listingId = created.body.id;
    expect(created.body).toMatchObject({ status: 'ACTIVE', images: [PHOTO], expiresAt: expect.any(String) });

    const feed = await api().get('/api/listings').query({ q: 'galaxy' }).expect(200);
    expect(feed.body.items.map((l: { id: string }) => l.id)).toContain(listingId);

    await api().patch(`/api/listings/${listingId}`).set(bearer(other.token)).send({ status: 'SOLD' }).expect(403);
    // A partial edit leaves the rest alone (regression: "mark as sold" used to wipe the price).
    const edited = await api().patch(`/api/listings/${listingId}`).set(bearer(seller.token)).send({ title: 'Samsung Galaxy S23 (128GB)' }).expect(200);
    expect(edited.body).toMatchObject({ title: 'Samsung Galaxy S23 (128GB)', price: 420000 });
    const sold = await api().patch(`/api/listings/${listingId}`).set(bearer(seller.token)).send({ status: 'SOLD', price: null }).expect(200);
    expect(sold.body.status).toBe('SOLD');
    expect(sold.body).not.toHaveProperty('price');

    const after = await api().get('/api/listings').query({ q: 'galaxy' }).expect(200);
    expect(after.body.total).toBe(0);

    const renewed = await api().post(`/api/listings/${listingId}/renew`).set(bearer(seller.token)).expect(200);
    expect(renewed.body.status).toBe('ACTIVE');

    const mine = await api().get('/api/me/listings').set(bearer(seller.token)).expect(200);
    expect(mine.body).toHaveLength(1);
  });

  it('hides taken-down listings from everyone but the seller', async () => {
    await api().patch(`/api/listings/${listingId}`).set(bearer(seller.token)).send({ status: 'REMOVED' }).expect(200);
    await api().get(`/api/listings/${listingId}`).expect(404);
    await api().get(`/api/listings/${listingId}`).set(bearer(seller.token)).expect(200);
  });

  it('reports once, never your own listing', async () => {
    await api().post('/api/listings/l1/reports').set(bearer(other.token)).send({ reason: 'scam' }).expect(201);
    await api().post('/api/listings/l1/reports').set(bearer(other.token)).send({ reason: 'scam' }).expect(409);
    await api().post(`/api/listings/${listingId}/reports`).set(bearer(seller.token)).send({ reason: 'scam' }).expect(400);
  });

  it('opens one shop, manages its catalog, and surfaces stock tasks', async () => {
    const shop = await api()
      .post('/api/storefronts')
      .set(bearer(seller.token))
      .send({ name: 'Amara Fabrics & Ankara', whatsappNumber: '+233 20 000 0002', category: 'Fashion & Fabric', city: 'Accra' })
      .expect(201);
    expect(shop.body.slug).toBe('amara-fabrics-ankara');
    await api()
      .post('/api/storefronts')
      .set(bearer(seller.token))
      .send({ name: 'Second', whatsappNumber: '+233200000002', category: 'Other', city: 'Accra' })
      .expect(409);

    const product = await api()
      .post(`/api/storefronts/${shop.body.id}/products`)
      .set(bearer(seller.token))
      .send({ title: 'Kente scarf', price: 300, currency: 'GHS', category: 'Accessories', description: 'Handwoven in Bonwire.' })
      .expect(201);
    await api().patch(`/api/products/${product.body.id}`).set(bearer(other.token)).send({ inStock: false }).expect(403);
    await api().patch(`/api/products/${product.body.id}`).set(bearer(seller.token)).send({ inStock: false, price: 280 }).expect(200);

    const domain = await api().patch(`/api/storefronts/${shop.body.id}`).set(bearer(seller.token)).send({ customDomain: 'kofiscarves.com' }).expect(200);
    expect(domain.body).toMatchObject({ customDomain: 'kofiscarves.com', domainStatus: 'PENDING' });

    const dash = await api().get('/api/me/dashboard').set(bearer(seller.token)).expect(200);
    expect(dash.body.tasks).toEqual(
      expect.arrayContaining([{ type: 'OUT_OF_STOCK', productId: product.body.id, title: 'Kente scarf' }, { type: 'GET_VERIFIED' }]),
    );
    expect(dash.body.stats).toMatchObject({ followers: 0, liveListings: 0 });

    await api().delete(`/api/products/${product.body.id}`).set(bearer(seller.token)).expect(204);
  });
});

describe('library', () => {
  it('saves and follows idempotently, and keeps follower counts honest', async () => {
    const buyer = await signIn('+256 700 000 004', 'Nakato Buyer');
    await api().put('/api/me/saved/l8').set(bearer(buyer.token)).expect(204);
    await api().put('/api/me/saved/l8').set(bearer(buyer.token)).expect(204);
    await api().put('/api/me/saved/missing').set(bearer(buyer.token)).expect(404);

    await api().put('/api/me/following/s2').set(bearer(buyer.token)).expect(204);
    await api().put('/api/me/following/s2').set(bearer(buyer.token)).expect(204);
    let shop = await api().get('/api/storefronts/kwame-sneaks').expect(200);
    expect(shop.body.followers).toBe(2872);

    await api().post('/api/me/recent').set(bearer(buyer.token)).send({ kind: 'listing', id: 'l1' }).expect(204);
    const lib = await api().get('/api/me/library').set(bearer(buyer.token)).expect(200);
    expect(lib.body).toMatchObject({
      saved: [{ listingId: 'l8', listing: { id: 'l8', seller: { id: 'u3' } } }],
      following: [{ storefrontId: 's2', storefront: { slug: 'kwame-sneaks' } }],
      recent: [{ kind: 'listing', id: 'l1', listing: { title: expect.stringContaining('iPhone') } }],
    });
    const saved = await api().get('/api/me/saved').set(bearer(buyer.token)).expect(200);
    expect(saved.body[0].listing.id).toBe('l8');

    await api().delete('/api/me/following/s2').set(bearer(buyer.token)).expect(204);
    await api().delete('/api/me/following/s2').set(bearer(buyer.token)).expect(204);
    shop = await api().get('/api/storefronts/kwame-sneaks').expect(200);
    expect(shop.body.followers).toBe(2871);
  });
});

describe('conversations', () => {
  it('opens one thread per listing, tracks unread, and stays private', async () => {
    const buyer = await signIn('+254 711 000 005', 'Wambui Buyer');
    const amara = await signIn('+234 802 314 8890');
    const stranger = await signIn('+254 711 000 006', 'Otieno Stranger');

    const opened = await api().post('/api/conversations').set(bearer(buyer.token)).send({ withUserId: 'u1', listingId: 'l3' }).expect(200);
    const again = await api().post('/api/conversations').set(bearer(buyer.token)).send({ withUserId: 'u1', listingId: 'l3' }).expect(200);
    expect(again.body.id).toBe(opened.body.id);
    // The buyer sees the seller's profile and is sent to her shop's WhatsApp line.
    expect(opened.body).toMatchObject({
      withUser: { id: 'u1', responseTime: 'usually replies within an hour' },
      whatsappNumber: '+2348023148890',
    });
    await api().post('/api/conversations').set(bearer(buyer.token)).send({ withUserId: buyer.user.id }).expect(400);

    await api().post(`/api/conversations/${opened.body.id}/messages`).set(bearer(buyer.token)).send({ body: 'Is the role still open?' }).expect(201);

    const inbox = await api().get('/api/conversations').set(bearer(amara.token)).expect(200);
    const thread = inbox.body.find((c: { id: string }) => c.id === opened.body.id);
    expect(thread).toMatchObject({ unread: true, withUser: { name: 'Wambui Buyer' }, lastMessage: { body: 'Is the role still open?' } });

    await api().post(`/api/conversations/${opened.body.id}/read`).set(bearer(amara.token)).expect(204);
    const after = await api().get('/api/conversations').set(bearer(amara.token)).expect(200);
    expect(after.body.find((c: { id: string }) => c.id === opened.body.id).unread).toBe(false);

    const dash = await api().get('/api/me/dashboard').set(bearer(amara.token)).expect(200);
    expect(dash.body.tasks.some((t: { type: string; conversationId?: string }) => t.type === 'REPLY_NEEDED' && t.conversationId === opened.body.id)).toBe(true);

    await api().get(`/api/conversations/${opened.body.id}/messages`).set(bearer(stranger.token)).expect(403);
    const msgs = await api().get(`/api/conversations/${opened.body.id}/messages`).set(bearer(amara.token)).expect(200);
    expect(msgs.body.map((m: { body: string }) => m.body)).toEqual(['Is the role still open?']);
  });
});

describe('reviews', () => {
  it('allows one review per seller, never yourself', async () => {
    const reviewer = await signIn('+234 803 000 0007', 'Chidi Reviewer');
    await api().post('/api/users/u4/reviews').set(bearer(reviewer.token)).send({ rating: 6 }).expect(400);
    const created = await api().post('/api/users/u4/reviews').set(bearer(reviewer.token)).send({ rating: 4, comment: 'Smooth handover.' }).expect(201);
    expect(created.body).toMatchObject({ rating: 4, from: { name: 'Chidi Reviewer' } });
    await api().post('/api/users/u4/reviews').set(bearer(reviewer.token)).send({ rating: 5 }).expect(409);
    await api().post(`/api/users/${reviewer.user.id}/reviews`).set(bearer(reviewer.token)).send({ rating: 5 }).expect(400);
  });
});

describe('uploads and verification', () => {
  it('keeps ID documents private, and runs verification through approval', async () => {
    const user = await signIn('+233 24 000 0008', 'Yaw Verify');

    // Public uploads are photos only, served so they can never run as a page.
    await api().post('/api/uploads').set(bearer(user.token)).attach('file', Buffer.from('hello'), 'notes.png').expect(415);
    await api().post('/api/uploads').set(bearer(user.token)).attach('file', PDF, 'flyer.pdf').expect(415);
    const up = await api().post('/api/uploads').set(bearer(user.token)).attach('file', PNG, 'photo.png').expect(201);
    expect(up.body).toMatchObject({ path: expect.stringMatching(/^\/uploads\/[\w-]+\.png$/), mimeType: 'image/png' });
    const served = await api().get(up.body.path).expect(200);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toContain('sandbox');

    // Documents go straight to private storage; there is no public URL to hand anyone.
    await api().post('/api/me/verification/documents').set(bearer(user.token)).send({}).expect(404);
    const withId = await api().post('/api/me/verification/id-document').set(bearer(user.token)).attach('file', PDF, 'id.pdf').expect(200);
    expect(withId.body).toMatchObject({ hasIdDocument: true, hasSelfie: false, status: 'NOT_STARTED' });
    await api().post('/api/me/verification/submit').set(bearer(user.token)).expect(400);
    await api().post('/api/me/verification/selfie').set(bearer(user.token)).attach('file', PDF, 'selfie.pdf').expect(415);
    await api().post('/api/me/verification/selfie').set(bearer(user.token)).attach('file', PNG, 'selfie.png').expect(200);
    const pending = await api().post('/api/me/verification/submit').set(bearer(user.token)).expect(200);
    expect(pending.body).toMatchObject({ status: 'PENDING', verified: false, hasIdDocument: true, hasSelfie: true });
    await api().post('/api/me/verification/selfie').set(bearer(user.token)).attach('file', PNG, 'again.png').expect(409);

    await api().get('/api/admin/verifications').set(bearer(user.token)).expect(403);
    await prisma.user.update({ where: { phone: '+254700000001' }, data: { role: 'ADMIN' } });
    const admin = await signIn('+254 700 000 001');
    const queue = await api().get('/api/admin/verifications').set(bearer(admin.token)).expect(200);
    const entry = queue.body.find((v: { userId: string }) => v.userId === user.user.id);
    expect(entry).toMatchObject({
      idDocument: expect.stringMatching(/^\/api\/admin\/verifications\/.+\/files\/id$/),
      user: { phone: '+233240000008' },
    });

    // Only moderators can open the files, and nothing caches them.
    await api().get(entry.idDocument).expect(401);
    await api().get(entry.idDocument).set(bearer(user.token)).expect(403);
    const doc = await api().get(entry.idDocument).set(bearer(admin.token)).expect(200);
    expect(doc.headers['content-type']).toContain('application/pdf');
    expect(doc.headers['cache-control']).toContain('no-store');
    await api().get(entry.selfie).set(bearer(admin.token)).expect(200);
    await api().get(entry.idDocument.replace(/id$/, 'passport')).set(bearer(admin.token)).expect(400);

    await api().post(`/api/admin/verifications/${user.user.id}/approve`).set(bearer(admin.token)).send({}).expect(200);
    const status = await api().get('/api/me/verification').set(bearer(user.token)).expect(200);
    expect(status.body).toMatchObject({ status: 'APPROVED', verified: true });

    // A shop opened after verification carries the badge from day one.
    const shop = await api()
      .post('/api/storefronts')
      .set(bearer(user.token))
      .send({ name: 'Yaw Phones', whatsappNumber: '+233 24 000 0008', category: 'Phones & Gadgets', city: 'Kumasi, Ghana' })
      .expect(201);
    expect(shop.body).toMatchObject({ isVerified: true, plan: 'FREE', domainStatus: 'NONE' });
  });
});

describe('security', () => {
  it("shows a person's phone number only once they sell", async () => {
    const buyer = await signIn('+256 790 000 001', 'Privacy Buyer');
    const tunde = await signIn('+234 810 552 6671');

    const buyerProfile = await api().get(`/api/users/${buyer.user.id}`).expect(200);
    expect(buyerProfile.body).not.toHaveProperty('phone');
    const sellerProfile = await api().get('/api/users/u4').expect(200);
    expect(sellerProfile.body.phone).toBe('+2348105526671');

    // The buyer sees how to reach the seller; the seller doesn't get the buyer's number.
    const chat = await api().post('/api/conversations').set(bearer(buyer.token)).send({ withUserId: 'u4', listingId: 'l12' }).expect(200);
    expect(chat.body).toMatchObject({ withUser: { id: 'u4', phone: '+2348105526671' }, whatsappNumber: '+2348105526671' });
    const sellerSide = await api().get(`/api/conversations/${chat.body.id}`).set(bearer(tunde.token)).expect(200);
    expect(sellerSide.body.withUser).not.toHaveProperty('phone');
    expect(sellerSide.body).not.toHaveProperty('whatsappNumber');

    // Your own number is always yours to see.
    const me = await api().get('/api/me').set(bearer(buyer.token)).expect(200);
    expect(me.body.phone).toBe('+256790000001');
  });

  it("won't start a chat about someone else's listing", async () => {
    const buyer = await signIn('+256 790 000 001', 'Privacy Buyer');
    const res = await api().post('/api/conversations').set(bearer(buyer.token)).send({ withUserId: 'u2', listingId: 'l1' }).expect(400);
    expect(res.body.message).toMatch(/belongs to someone else/);
  });

  it('only accepts photos uploaded to Sokoni', async () => {
    const seller = await signIn('+256 790 000 002', 'Photo Seller');
    const listing = { category: 'FOR_SALE', title: 'Desk lamp', description: 'Works well, warm light.', currency: 'UGX', city: 'Kampala' };
    const bad = [['https://tracker.example/p.png'], ['/uploads/0b7d6a3e-1c2f-4a5b-9c8d-7e6f5a4b3c2d.pdf'], ['/uploads/../.env']];
    for (const images of bad) {
      await api().post('/api/listings').set(bearer(seller.token)).send({ ...listing, images }).expect(400);
    }
    await api().patch('/api/me').set(bearer(seller.token)).send({ avatarUrl: 'https://tracker.example/me.png' }).expect(400);
    await api().post('/api/listings').set(bearer(seller.token)).send({ ...listing, images: [PHOTO] }).expect(201);
  });

  it("doesn't let people write their own response time", async () => {
    const seller = await signIn('+256 790 000 002', 'Photo Seller');
    await api().patch('/api/me').set(bearer(seller.token)).send({ responseTime: 'Verified by Sokoni staff' }).expect(400);
  });

  it('keeps moderator takedowns in place, and moderators out of what sellers wrote', async () => {
    const seller = await signIn('+256 790 000 003', 'Takedown Seller');
    const created = await api()
      .post('/api/listings')
      .set(bearer(seller.token))
      .send({ category: 'FOR_SALE', title: 'Too good to be true', description: 'Brand new phone, pay first please.', price: 1000, currency: 'UGX', city: 'Kampala' })
      .expect(201);
    const shop = await api()
      .post('/api/storefronts')
      .set(bearer(seller.token))
      .send({ name: 'Takedown Test Shop', whatsappNumber: '+256 790 000 003', category: 'Electronics', city: 'Kampala, Uganda' })
      .expect(201);

    const mod = await signIn('+256 790 000 004', 'Test Moderator');
    await prisma.user.update({ where: { id: mod.user.id }, data: { role: 'MODERATOR' } });

    const path = `/api/listings/${created.body.id}`;
    await api().patch(path).set(bearer(mod.token)).send({ title: 'Edited by a moderator' }).expect(403);
    await api().patch(path).set(bearer(mod.token)).send({ status: 'REMOVED' }).expect(200);
    await api().get(path).expect(404);

    await api().patch(path).set(bearer(seller.token)).send({ status: 'ACTIVE' }).expect(403);
    await api().post(`${path}/renew`).set(bearer(seller.token)).expect(403);
    await api().patch(path).set(bearer(seller.token)).send({ title: 'Totally legit now' }).expect(403);

    // A shop's WhatsApp number is where buyers pay: only its owner changes it.
    await api().patch(`/api/storefronts/${shop.body.id}`).set(bearer(mod.token)).send({ whatsappNumber: '+256 700 666 666' }).expect(403);

    await api().patch(path).set(bearer(mod.token)).send({ status: 'ACTIVE' }).expect(200);
    await api().patch(path).set(bearer(seller.token)).send({ status: 'SOLD' }).expect(200);
  });

  it('caps one-time codes per phone number, whatever address asks', async () => {
    const phone = '+256790000099';
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    await prisma.otpCode.createMany({
      data: [5, 15, 25, 35, 45].map((m) => ({ phone, purpose: 'LOGIN' as const, codeHash: 'x', createdAt: minutesAgo(m), expiresAt: minutesAgo(m - 5) })),
    });
    const res = await api().post('/api/auth/otp/request').send({ phone: '+256 790 000 099' }).expect(429);
    expect(res.body.message).toMatch(/Too many codes for this number/);
  });
});
