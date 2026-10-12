# Sokoni API reference

Every endpoint the Sokoni frontend needs, with its request and response. The examples are real responses captured from this server running on the seed data, trimmed where marked `…`.

- **Base URL:** `http://localhost:4000/api`
- **Interactive docs:** `http://localhost:4000/api/docs` (Swagger UI); the OpenAPI JSON is at `/api/docs-json`. On by default in development, off in production unless `SWAGGER_ENABLED=true`.
- **Uploaded photos** are served outside the prefix: `http://localhost:4000/uploads/<file>`. ID documents are never served there; see [Verification](#verification).

There are 57 operations. The [index](#endpoint-index) lists them all, and [How the web app uses this API](#how-the-web-app-uses-this-api) shows where each one is called.

---

## Conventions

| Topic | Rule |
| --- | --- |
| Format | JSON in and out. The only exception is `POST /uploads`, which takes `multipart/form-data`. |
| Auth | `Authorization: Bearer <accessToken>`, issued by [`POST /auth/otp/verify`](#post-authotpverify). Tokens last 7 days (`JWT_EXPIRES_IN`) and there are no refresh tokens yet: sign in again when you get a 401. |
| Public reads | Endpoints without 🔒 work signed out. Sending a token is harmless and lets the owner or a moderator see their own removed listings. |
| Dates | ISO 8601 strings in UTC, for example `"2026-09-01T00:00:00.000Z"`. |
| Money | `price` is an integer in whole currency units: `380000` with `"currency": "NGN"` means ₦380,000. Currencies are `NGN`, `GHS`, `KES` and `UGX`. A listing with no `price` is "contact for price". |
| Optional fields | Optional fields on records are **omitted** when they have no value, not sent as `null`. This matches the `?` fields in the frontend's `src/lib/types.ts`. The dashboard stats are the one place that uses `null`. |
| Pagination | Paged lists take `?page=1&limit=20` (`limit` is at most 50) and return `{ "items": [...], "total": 12, "page": 1, "limit": 20 }`. |
| Unknown fields | A request body containing a field the endpoint doesn't accept gets a 400. The validator rejects it rather than silently dropping it. |
| Rate limits | 120 requests a minute per client IP overall. Tighter limits apply per route: requesting a one-time code (5 a minute), verifying one (10), uploads (30), new listings (20), new chats (20), messages (30), reports and reviews (10 each), verification documents (10). Each phone number also gets at most 5 codes an hour, whatever IP asks. Over a limit you get a 429. |
| IDs | Opaque strings. The seed uses the frontend's ids (`u1`, `s1`, `p1`, `l1`, `c1` …), and new records get CUIDs. |

### Errors

Every error has the same shape:

```json
{ "message": "Listing not found", "error": "Not Found", "statusCode": 404 }
```

Validation failures return `message` as an array, one entry per problem:

```json
{
  "message": ["property colour should not exist", "title must be longer than or equal to 3 characters"],
  "error": "Bad Request",
  "statusCode": 400
}
```

Some errors also carry a machine-readable `code` that the UI can branch on:

| Status | `code` | When |
| --- | --- | --- |
| 422 | `NAME_REQUIRED` | `POST /auth/otp/verify` for a new phone number that was sent without a `name`. Ask for the name and resend. |
| 409 | `STOREFRONT_EXISTS` | `POST /storefronts` when you already have a shop. The body also includes `slug`, the slug of your existing shop. |
| 404 | `NO_STOREFRONT` | `GET /me/storefront` before you have opened a shop. |

| Status | Meaning |
| --- | --- |
| 400 | Invalid body or query, a wrong or expired one-time code, or a disallowed action such as reviewing yourself or following your own shop. |
| 401 | Not signed in, or an expired or invalid token. |
| 403 | Signed in, but not the owner or a participant, missing the admin/moderator role, or a listing the trust team took down. |
| 404 | Not found. Removed listings are also 404 to everyone except their owner and moderators. |
| 409 | Duplicate: already reported, already reviewed, the domain or email is taken, or you already have a shop. Also: verification documents while a review is pending, or once you're verified. |
| 413 | Upload larger than 5 MB. |
| 415 | Upload of the wrong type: photos must be JPEG, PNG or WebP; an ID document may also be a PDF. The server checks the file's bytes, not its name. |
| 429 | Rate limit, asking for a new one-time code within 30 seconds of the last one, or 5 wrong tries at a code. |

---

## Shared shapes

These are the shapes responses are built from. They follow `Monorepo frontend/src/lib/types.ts`; the differences are listed in [Differences from the frontend types](#differences-from-the-frontend-types).

```ts
type Category = "FOR_SALE" | "HOUSING" | "JOBS" | "SERVICES" | "GIGS" | "COMMUNITY";
type ListingStatus = "ACTIVE" | "SOLD" | "EXPIRED" | "REMOVED";

/** The person behind a listing, chat or review: just enough to render a trust ring. */
interface SellerSummary {
  id: string;
  name: string;
  avatarUrl?: string;
  verified: boolean;
  trustScore: number; // 0–100
}

/** A public profile. */
interface PublicUser extends SellerSummary {
  /**
   * WhatsApp contact, E.164 ("+2348023148890"). Only present for people who
   * sell (a shop or a live listing): a buyer's number is never public.
   */
  phone?: string;
  role: "USER" | "ADMIN" | "MODERATOR";
  memberSince: string;
  responseTime?: string; // "usually replies within an hour"
}

/** The signed-in user. Adds private fields. Your own phone is always present. */
interface MeUser extends PublicUser {
  phone: string;
  email?: string;
  phoneVerified: boolean;
}

interface Listing {
  id: string;
  sellerId: string;
  category: Category;
  title: string;
  description: string;
  price?: number; // omitted = contact for price
  currency: string;
  images: string[]; // URLs, in display order
  location: { lat: number; lng: number; city: string; country: string };
  status: ListingStatus; // EXPIRED is computed from expiresAt
  createdAt: string;
  expiresAt?: string; // 30 days after posting or renewing
  featured?: boolean;
  seller: SellerSummary; // embedded so cards don't need a second request
}

interface Storefront {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  bio: string;
  logoUrl?: string;
  coverUrl?: string;
  whatsappNumber: string;
  category: string; // "Fashion & Fabric"
  city: string; // "Lagos, Nigeria"
  isVerified: boolean;
  plan: "FREE" | "PRO" | "BUSINESS";
  productIds: string[]; // oldest first
  followers: number;
  responseRate?: number; // percent
  customDomain?: string;
  domainStatus: "NONE" | "PENDING" | "VERIFIED";
}

interface Product {
  id: string;
  storefrontId: string;
  title: string;
  price: number;
  currency: string;
  images: string[];
  inStock: boolean;
  category: string; // the shop's own section, e.g. "Fabric"
  description: string;
  createdAt: string;
}

interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

/** One chat, from the signed-in user's side. */
interface ConversationSummary {
  id: string;
  listingId?: string;
  listing?: Listing; // the item being negotiated
  withUser: PublicUser; // the other person, with their response time
  whatsappNumber?: string; // "Continue on WhatsApp": their shop's number, else theirs if they sell; absent for buyers
  lastMessage?: Message;
  lastMessageAt: string;
  unread: boolean; // the latest message is theirs and newer than my last read
}

interface Review {
  id: string;
  fromUserId: string;
  toUserId: string;
  rating: number; // 1–5
  comment?: string;
  createdAt: string;
  from: SellerSummary; // the reviewer
}

interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}
```

---

## Endpoint index

🔒 = needs a bearer token. 🛡 = needs the `ADMIN` or `MODERATOR` role.

| Method | Path | | Purpose |
| --- | --- | --- | --- |
| POST | [`/auth/otp/request`](#post-authotprequest) | | Text a sign-in code to a phone number |
| POST | [`/auth/otp/verify`](#post-authotpverify) | | Exchange the code for a token, creating the account if needed |
| GET | [`/listings`](#get-listings) | | Browse and filter live listings (paged) |
| POST | [`/listings`](#post-listings) | 🔒 | Post an ad |
| GET | [`/listings/:id`](#get-listingsid) | | One listing |
| PATCH | [`/listings/:id`](#patch-listingsid) | 🔒 | Edit, mark sold, relist or remove |
| GET | [`/listings/:id/related`](#get-listingsidrelated) | | More from this seller and similar listings |
| POST | [`/listings/:id/renew`](#post-listingsidrenew) | 🔒 | Renew for another 30 days |
| POST | [`/listings/:id/reports`](#post-listingsidreports) | 🔒 | Report a listing |
| GET | [`/storefronts`](#get-storefronts) | | Browse shops (paged) |
| POST | [`/storefronts`](#post-storefronts) | 🔒 | Open a shop |
| GET | [`/storefronts/:slug`](#get-storefrontsslug) | | One shop |
| GET | [`/storefronts/:slug/products`](#get-storefrontsslugproducts) | | A shop's products |
| PATCH | [`/storefronts/:id`](#patch-storefrontsid) | 🔒 | Edit a shop, including its custom domain |
| POST | [`/storefronts/:id/products`](#post-storefrontsidproducts) | 🔒 | Add a product |
| GET | [`/products/:id`](#get-productsid) | | One product |
| PATCH | [`/products/:id`](#patch-productsid) | 🔒 | Edit a product or toggle stock |
| DELETE | [`/products/:id`](#delete-productsid) | 🔒 | Delete a product |
| GET | [`/users/:id`](#get-usersid) | | Public profile with rating |
| GET | [`/users/:id/listings`](#get-usersidlistings) | | A person's live listings |
| GET | [`/users/:id/storefront`](#get-usersidstorefront) | | A person's shop |
| GET | [`/users/:id/reviews`](#get-usersidreviews) | | Reviews of a person |
| POST | [`/users/:id/reviews`](#post-usersidreviews) | 🔒 | Review a seller |
| GET | [`/search`](#get-search) | | Search listings, shops and sellers, with a top result |
| GET | [`/categories`](#get-categories) | | Listing categories with live counts |
| GET | [`/categories/shops`](#get-categoriesshops) | | Suggested shop categories |
| GET | [`/me`](#get-me) | 🔒 | The signed-in user |
| PATCH | [`/me`](#patch-me) | 🔒 | Edit my profile |
| GET | [`/me/storefront`](#get-mestorefront) | 🔒 | My shop |
| GET | [`/me/listings`](#get-melistings) | 🔒 | My listings, in every status |
| GET | [`/me/dashboard`](#get-medashboard) | 🔒 | Seller stats and to-dos |
| GET | [`/me/library`](#get-melibrary) | 🔒 | Everything I've saved, followed and recently viewed |
| GET | [`/me/saved`](#get-mesaved) | 🔒 | Saved items, with the listings |
| PUT | [`/me/saved/:listingId`](#put-mesavedlistingid) | 🔒 | Save an item |
| DELETE | [`/me/saved/:listingId`](#delete-mesavedlistingid) | 🔒 | Unsave an item |
| GET | [`/me/following`](#get-mefollowing) | 🔒 | Shops I follow |
| PUT | [`/me/following/:storefrontId`](#put-mefollowingstorefrontid) | 🔒 | Follow a shop |
| DELETE | [`/me/following/:storefrontId`](#delete-mefollowingstorefrontid) | 🔒 | Unfollow a shop |
| POST | [`/me/recent`](#post-merecent) | 🔒 | Record a view in "Recently viewed" |
| GET | [`/conversations`](#get-conversations) | 🔒 | My chats |
| POST | [`/conversations`](#post-conversations) | 🔒 | Open or reuse a chat about an item |
| GET | [`/conversations/:id`](#get-conversationsid) | 🔒 | One chat with its latest messages |
| GET | [`/conversations/:id/messages`](#get-conversationsidmessages) | 🔒 | Older messages |
| POST | [`/conversations/:id/messages`](#post-conversationsidmessages) | 🔒 | Send a message |
| POST | [`/conversations/:id/read`](#post-conversationsidread) | 🔒 | Mark a chat read |
| GET | [`/me/verification`](#get-meverification) | 🔒 | My ID-verification status |
| POST | [`/me/verification/phone/request`](#post-meverificationphonerequest) | 🔒 | Text a code to confirm my phone |
| POST | [`/me/verification/phone/confirm`](#post-meverificationphoneconfirm) | 🔒 | Confirm my phone |
| POST | [`/me/verification/id-document`](#post-meverificationid-document) | 🔒 | Upload my ID document (private) |
| POST | [`/me/verification/selfie`](#post-meverificationselfie) | 🔒 | Upload my selfie (private) |
| POST | [`/me/verification/submit`](#post-meverificationsubmit) | 🔒 | Send my documents for review |
| GET | [`/admin/verifications`](#get-adminverifications) | 🛡 | The verification review queue |
| GET | [`/admin/verifications/:userId/files/:kind`](#get-adminverificationsuseridfileskind) | 🛡 | Open a submitted ID or selfie |
| POST | [`/admin/verifications/:userId/approve`](#post-adminverificationsuseridapprove) | 🛡 | Approve a verification |
| POST | [`/admin/verifications/:userId/reject`](#post-adminverificationsuseridreject) | 🛡 | Reject a verification |
| POST | [`/uploads`](#post-uploads) | 🔒 | Upload a photo |
| GET | [`/health`](#get-health) | | Liveness and database check |

---

## Auth

Sign-in is by phone number with a one-time code: there are no passwords. The same two calls sign in an existing account and create a new one.

Codes are 6 digits, expire after 5 minutes, allow 5 attempts and work once. A new code can be requested every 30 seconds, and at most 5 times an hour for the same number. That cap is per number, not per IP, so it holds however many addresses a caller uses. No SMS provider is connected yet, so the server writes the code to its log. When `OTP_DEV_ECHO=true` (development only; the server refuses to start with it in production), the response also includes `devCode`.

### POST /auth/otp/request

```json
{ "phone": "+234 802 314 8890" }
```

`phone` must include the country code. Spaces, dashes and brackets are allowed and stripped.

**200**

```json
{ "sent": true, "expiresInSeconds": 300, "devCode": "478977" }
```

### POST /auth/otp/verify

```json
{ "phone": "+234 802 314 8890", "code": "478977", "name": "Amara Chukwu" }
```

`name` (at most 80 characters) is required only the first time a number signs in. Without it, a new number gets a **422** with `code: "NAME_REQUIRED"`, and the code stays valid so you can resend it with the name. The 422 only comes after the code checks out, so it can't be used to find out which numbers have accounts.

A wrong code is a **400** (`"That code is not right"`), as is an expired one or one that was never requested. After 5 wrong tries the code is locked: **429**.

**200**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "tokenType": "Bearer",
  "isNewUser": false,
  "user": {
    "id": "u1",
    "name": "Amara Chukwu",
    "verified": true,
    "trustScore": 92,
    "phone": "+2348023148890",
    "role": "USER",
    "memberSince": "2022-03-11T00:00:00.000Z",
    "responseTime": "usually replies within an hour",
    "email": "amara@amarafabrics.ng",
    "phoneVerified": true
  }
}
```

Signing in with a code also marks the phone as verified (`phoneVerified: true`).

---

## Listings

Classified ads. Public feeds only include **live** listings: those that are `ACTIVE` and not past `expiresAt`.

### GET /listings

| Query | Type | Notes |
| --- | --- | --- |
| `category` | `Category` | e.g. `FOR_SALE` |
| `city` | string | exact city, e.g. `Lagos` |
| `q` | string | Words to find in the title, description, city, country, seller name or category label ("housing", "gigs"). Every word must match. |
| `verifiedOnly` | boolean | Only ID-verified sellers. |
| `featured` | boolean | |
| `sellerId` | string | |
| `sort` | `newest` (default), `price-asc`, `price-desc`, `trust` | `trust` sorts by the seller's trust score. In the price sorts, listings without a price come last. |
| `page`, `limit` | int | See [Conventions](#conventions). |

**200** `Page<Listing>`

```json
{
  "items": [
    {
      "id": "l1",
      "sellerId": "u4",
      "category": "FOR_SALE",
      "title": "iPhone 13 Pro, 256GB — barely used",
      "description": "Bought new in January, screen protector on since day one, no scratches. Comes with original box and charger. Battery health 96%.",
      "price": 380000,
      "currency": "NGN",
      "images": [],
      "location": { "lat": 6.5244, "lng": 3.3792, "city": "Lagos", "country": "Nigeria" },
      "status": "ACTIVE",
      "createdAt": "2026-09-01T00:00:00.000Z",
      "featured": true,
      "seller": { "id": "u4", "name": "Tunde Bakare", "verified": true, "trustScore": 61 }
    }
  ],
  "total": 4,
  "page": 1,
  "limit": 1
}
```

### POST /listings

🔒 Post an ad. The listing goes live straight away and expires after 30 days.

```json
{
  "category": "FOR_SALE",
  "title": "Samsung 55\" Smart TV",
  "description": "Two years old, works perfectly, remote included.",
  "price": 210000,
  "currency": "NGN",
  "city": "Lagos",
  "country": "Nigeria",
  "lat": 6.5244,
  "lng": 3.3792,
  "images": ["/uploads/9b1d…e2.jpg"]
}
```

| Field | Rule |
| --- | --- |
| `category` | required, a `Category` |
| `title` | required, 3–80 characters |
| `description` | required, 10–4000 characters |
| `price` | optional integer ≥ 0. Omit it or send `null` for "contact for price". |
| `currency` | required: `NGN`, `GHS`, `KES` or `UGX` |
| `city` | required, 2–60 characters |
| `country` | optional, at most 60 characters. Left empty when omitted. |
| `lat`, `lng` | optional coordinates |
| `images` | optional, up to 8 URLs returned by [`POST /uploads`](#post-uploads), in display order |

**201** `Listing`, with `expiresAt` set.

### GET /listings/:id

**200** `Listing`. **404** if the listing doesn't exist, or if it was removed and you're not its seller or a moderator. Sold and expired listings are still returned, so links keep working; the UI shows their status.

### PATCH /listings/:id

🔒 The seller. Send any of `category`, `title`, `description`, `price`, `currency`, `city`, `country` and `images` (same rules as creating), plus `status`. Fields you leave out stay as they are:

```json
{ "status": "SOLD" }
```

- `status` is `ACTIVE` to relist, `SOLD` to mark sold, or `REMOVED` to take the listing down.
- Setting `ACTIVE` gives the listing a fresh 30 days. [Renew](#post-listingsidrenew) does that too, and also moves it back to the top of the feed.
- `"price": null` switches the listing to "contact for price". Leaving `price` out keeps it.

**Moderators** (role `MODERATOR` or `ADMIN`) may only send `{ "status": "REMOVED" }` to take a listing down, or `{ "status": "ACTIVE" }` to restore it. They can't edit what the seller wrote. While a listing is taken down by a moderator, its seller can't edit, relist or renew it (**403**).

**200** `Listing`. **403** if you're not the seller, or the trust team took the listing down.

### GET /listings/:id/related

The two shelves under a listing.

**200**

```json
{
  "moreFromSeller": [{ "id": "l12", "title": "Handmade leather sandals (bulk lot of 12 pairs)", "…": "…" }],
  "sameCategory": [{ "id": "l8", "title": "MacBook Air M2, 512GB — Space Grey", "…": "…" }]
}
```

Each shelf holds up to 8 live `Listing`s. `sameCategory` leaves out this seller's own listings.

### POST /listings/:id/renew

🔒 The seller. Sets the status to `ACTIVE`, the expiry to 30 days from now, and `createdAt` to now, so the listing returns to the top of the newest-first feed.

**200** `Listing`. **403** for anyone else, and for a listing the trust team took down.

### POST /listings/:id/reports

🔒 Backs the "Report listing" menu item.

```json
{ "reason": "scam", "details": "Asked me to pay a deposit before viewing." }
```

`reason` is one of `scam`, `prohibited`, `wrong-category`, `duplicate`, `offensive` or `other`. `details` is optional, at most 1000 characters.

**201** `{ "reported": true }`. **409** if you've already reported this listing. **400** if it's your own listing.

---

## Storefronts and products

The always-on WhatsApp shop. A person has at most one shop. Orders happen on WhatsApp through `whatsappNumber`; the API takes no payments.

### GET /storefronts

| Query | Notes |
| --- | --- |
| `q` | Words to find in the name, bio, category or city |
| `city` | Partial match, e.g. `Lagos` |
| `category` | Exact match, e.g. `Fashion & Fabric` |
| `page`, `limit` | |

Verified shops come first, then shops with the most followers.

**200** `Page<Storefront>`

### POST /storefronts

🔒 Open your shop. The slug is made from the name and made unique, so `"Kwame Sneaks"` becomes `kwame-sneaks`, or `kwame-sneaks-2` if that is taken. The plan starts at `FREE`.

```json
{
  "name": "Amara Fabrics & Ankara",
  "bio": "Hand-picked Ankara, lace, and adire from Lagos tailors.",
  "whatsappNumber": "+234 802 314 8890",
  "category": "Fashion & Fabric",
  "city": "Lagos, Nigeria"
}
```

| Field | Rule |
| --- | --- |
| `name` | required, 2–80 characters |
| `bio` | optional, at most 280 characters |
| `whatsappNumber` | required, with country code |
| `category` | required, 2–60 characters. Suggestions come from [`GET /categories/shops`](#get-categoriesshops). |
| `city` | required, 2–80 characters |

**201** `Storefront`, with `plan: "FREE"`. The shop is `isVerified` if its owner already is. **409** with `code: "STOREFRONT_EXISTS"` and your existing `slug` if you already have one.

### GET /storefronts/:slug

**200** `Storefront`

```json
{
  "id": "s1",
  "ownerId": "u1",
  "slug": "amara-fabrics",
  "name": "Amara Fabrics & Ankara",
  "bio": "Hand-picked Ankara, lace, and adire from Lagos tailors. Custom cuts by the yard, same-week delivery across Nigeria.",
  "whatsappNumber": "+2348023148890",
  "category": "Fashion & Fabric",
  "city": "Lagos, Nigeria",
  "isVerified": true,
  "plan": "BUSINESS",
  "productIds": ["p4", "p2", "p1", "p3"],
  "followers": 4218,
  "responseRate": 97,
  "domainStatus": "NONE"
}
```

### GET /storefronts/:slug/products

**200** `Product[]`: in-stock products first, then oldest first within each group.

```json
[
  {
    "id": "p2",
    "storefrontId": "s1",
    "title": "Handwoven Aso-Oke Gele",
    "price": 9500,
    "currency": "NGN",
    "images": [],
    "inStock": true,
    "category": "Accessories",
    "description": "Traditional handwoven gele, pre-shaped…",
    "createdAt": "…"
  }
]
```

### PATCH /storefronts/:id

🔒 The owner only: a shop's name and WhatsApp number are where buyers send money, so no one else, staff included, can change them. Note that this route uses the shop's **id**, not its slug, so that renaming can't break the URL you're calling. The slug stays the same when you rename.

Any subset of the create fields, plus:

| Field | Rule |
| --- | --- |
| `logoUrl`, `coverUrl` | Paths from [`POST /uploads`](#post-uploads) |
| `customDomain` | A hostname like `kwamesneaks.com`. It is saved with `domainStatus: "PENDING"`; DNS and SSL checking isn't built yet, so it never becomes `VERIFIED` on its own. Send `""` or `null` to remove it (status `NONE`). **409** if another shop has reserved it. |

**200** `Storefront`.

### POST /storefronts/:id/products

🔒 The owner.

```json
{
  "title": "Premium Ankara — 6 yards",
  "price": 18500,
  "currency": "NGN",
  "category": "Fabric",
  "description": "Wax-print Ankara, 6 yards, wide range of colourways.",
  "inStock": true,
  "images": []
}
```

| Field | Rule |
| --- | --- |
| `title` | 3–80 characters |
| `price` | integer ≥ 0, required |
| `currency` | as for listings |
| `category` | 2–40 characters |
| `description` | 10–2000 characters |
| `inStock` | optional, defaults to `true` |
| `images` | optional, up to 8 upload URLs |

**201** `Product`.

### GET /products/:id

**200** `Product`

```json
{
  "id": "p1",
  "storefrontId": "s1",
  "title": "Premium Ankara — 6 yards",
  "price": 18500,
  "currency": "NGN",
  "images": [],
  "inStock": true,
  "category": "Fabric",
  "description": "Wax-print Ankara, 6 yards, wide range of colourways. Ideal for aso-ebi sets.",
  "createdAt": "2026-06-02T00:00:00.000Z"
}
```

### PATCH /products/:id

🔒 The shop owner. Any subset of the product fields. For example, `{ "inStock": false }` marks a product out of stock.

**200** `Product`.

### DELETE /products/:id

🔒 The shop owner. **204**, no body.

---

## People and reviews

### GET /users/:id

**200** `PublicUser` plus `rating` (the average, 0 when there are no reviews) and `reviewCount`. `phone` is included only if the person sells (a shop or a live listing).

```json
{
  "id": "u4",
  "name": "Tunde Bakare",
  "verified": true,
  "trustScore": 61,
  "phone": "+2348105526671",
  "role": "USER",
  "memberSince": "2024-01-19T00:00:00.000Z",
  "rating": 3,
  "reviewCount": 1
}
```

### GET /users/:id/listings

**200** `Listing[]`: this person's live listings, newest first.

### GET /users/:id/storefront

**200** `Storefront`. **404** `"This person has no shop"`.

### GET /users/:id/reviews

**200** `Review[]`, newest first.

```json
[
  {
    "id": "r1",
    "fromUserId": "u5",
    "toUserId": "u1",
    "rating": 5,
    "comment": "Fabric quality was even better than the photos. Fast delivery to Nairobi too!",
    "createdAt": "2026-06-10T00:00:00.000Z",
    "from": { "id": "u5", "name": "Grace Achieng", "verified": false, "trustScore": 74 }
  }
]
```

### POST /users/:id/reviews

🔒 One review per buyer per seller.

```json
{ "rating": 5, "comment": "Exactly as described, delivered next day." }
```

`rating` is 1–5. `comment` is optional, at most 1000 characters.

**201** `Review`. **409** if you've already reviewed this seller. **400** if you try to review yourself.

---

## Search and categories

### GET /search

| Query | Notes |
| --- | --- |
| `q` | The search words. Every word must match a field, the same rule as the frontend's `lib/search.ts`. |
| `type` | `all` (default), `listings`, `shops` or `sellers` |

Returns up to 30 of each kind. Only live listings are searched; shops match on name, bio, category or city; sellers are people with a shop or a live listing, matched by name.

`topResult` follows the frontend's `pickTopResult`. The first match wins, in this order:

1. a shop whose name contains the query;
2. a seller whose name contains it;
3. a listing whose title contains it;
4. the first listing, shop or seller.

It is `null` when `q` is empty or nothing matched.

**200**

```json
{
  "q": "kwame",
  "type": "all",
  "topResult": {
    "kind": "shop",
    "shop": { "id": "s2", "slug": "kwame-sneaks", "name": "Kwame Sneaks", "…": "…" }
  },
  "listings": [{ "…": "2 Listing objects" }],
  "shops": [{ "…": "1 Storefront" }],
  "sellers": [{ "…": "1 PublicUser" }]
}
```

`topResult` is one of `{ "kind": "listing", "listing": Listing }`, `{ "kind": "shop", "shop": Storefront }`, `{ "kind": "seller", "user": PublicUser }` or `null`. With `type` set to one kind, the other arrays are empty.

### GET /categories

The browse grid and the category pages. `label`, `blurb` and `color` are the same values as `categoryMeta` in the frontend. `cities` lists where the category has live listings, for the city filter chips.

**200**

```json
[
  { "key": "FOR_SALE", "label": "For Sale", "blurb": "Electronics, vehicles, furniture & more", "color": "#e13300", "liveCount": 4, "cities": ["Abuja", "Lagos", "Nairobi"] },
  { "key": "HOUSING", "label": "Housing", "blurb": "Rentals, shortlets & land", "color": "#1e3264", "liveCount": 2, "cities": ["Lagos", "Nairobi"] },
  { "key": "JOBS", "…": "…" },
  { "key": "SERVICES", "…": "…" },
  { "key": "GIGS", "…": "…" },
  { "key": "COMMUNITY", "…": "…" }
]
```

### GET /categories/shops

**200** `string[]`: suggested shop categories for the "Open a shop" form, for example `["Fashion & Fabric", "Sneakers & Streetwear", …]`.

---

## Me

Everything under `/me` needs a token.

### GET /me

**200** `MeUser`

```json
{
  "id": "u1",
  "name": "Amara Chukwu",
  "verified": true,
  "trustScore": 92,
  "phone": "+2348023148890",
  "role": "USER",
  "memberSince": "2022-03-11T00:00:00.000Z",
  "responseTime": "usually replies within an hour",
  "email": "amara@amarafabrics.ng",
  "phoneVerified": true
}
```

### PATCH /me

```json
{ "name": "Amara Chukwu", "email": "amara@amarafabrics.ng", "avatarUrl": "/uploads/0b7d6a3e-….jpg" }
```

All fields are optional. `name` is 2–80 characters, and `avatarUrl` must be a path from [`POST /uploads`](#post-uploads). The phone number can't be changed here, because it is the sign-in identity. `responseTime` can't be set either: buyers read it as a trust signal, so it isn't self-declared.

**200** `MeUser`. **409** if the email is used by another account.

### GET /me/storefront

**200** `Storefront`. **404** with `code: "NO_STOREFRONT"` if you haven't opened a shop yet.

### GET /me/listings

`?status=ACTIVE|SOLD|EXPIRED|REMOVED` is optional.

**200** `Listing[]`: all your listings, in every status, newest first. The dashboard's Listings tab uses this.

### GET /me/dashboard

The seller home: four stats and a to-do list.

**200**

```json
{
  "stats": { "followers": 4218, "liveListings": 1, "openChats": 2, "responseRate": 97 },
  "tasks": [
    {
      "type": "REPLY_NEEDED",
      "conversationId": "c2",
      "listingId": "l12",
      "withUser": { "id": "u4", "name": "Tunde Bakare", "verified": true, "trustScore": 61 },
      "lastMessage": { "id": "m5", "conversationId": "c2", "senderId": "u4", "body": "Yes, all 12 available. I can deliver to your Lagos shop this week.", "createdAt": "2026-09-06T12:20:00.000Z" }
    },
    { "type": "OUT_OF_STOCK", "productId": "p4", "title": "Adire Tie-Dye Wrapper Set" }
  ]
}
```

- `followers` and `responseRate` come from your shop, and are `null` when you have no shop.
- `liveListings` counts your listings that are active and not expired.
- `openChats` counts all your chats. The ones waiting on you appear as `REPLY_NEEDED` tasks.

Task types:

| `type` | Extra fields | Meaning |
| --- | --- | --- |
| `REPLY_NEEDED` | `conversationId`, `listingId?`, `withUser`, `lastMessage` | A buyer is waiting for your reply. |
| `OUT_OF_STOCK` | `productId`, `title` | A product in your shop is out of stock. |
| `LISTING_EXPIRED` | `listingId`, `title` | A listing expired; offer to [renew](#post-listingsidrenew) it. |
| `GET_VERIFIED` | none | You aren't ID-verified yet. |

### GET /me/library

Everything "Saved & following" shows, with the records embedded. One request covers the sidebar, the Saved items page, the save and follow buttons, and the home page's "Recently viewed" and "Shops you follow" shelves. The web app loads it with the session on every full page load.

**200**

```json
{
  "saved": [
    { "listingId": "l8", "at": "2026-09-01T10:00:00.000Z", "listing": { "id": "l8", "title": "MacBook Air M2, 512GB — Space Grey", "…": "Listing" } }
  ],
  "following": [
    { "storefrontId": "s2", "at": "…", "storefront": { "id": "s2", "slug": "kwame-sneaks", "…": "Storefront" } }
  ],
  "recent": [
    { "kind": "listing", "id": "l1", "at": "…", "listing": { "…": "Listing" } },
    { "kind": "shop", "id": "s1", "at": "…", "storefront": { "…": "Storefront" } }
  ]
}
```

Each list is newest first. `recent` keeps at most 12 entries. Removed listings drop out of `saved` and `recent`; sold and expired ones stay, so check `listing.status`.

### GET /me/saved

The full listings, for the Saved items page.

**200**

```json
[
  {
    "savedAt": "2026-09-01T10:00:00.000Z",
    "listing": { "id": "l8", "title": "MacBook Air M2, 512GB — Space Grey", "price": 145000, "currency": "KES", "…": "…" }
  }
]
```

Saved listings stay in the list after they sell or expire, so check `listing.status` to show them as unavailable. Listings that have been removed drop out.

### PUT /me/saved/:listingId

**204**. Idempotent: saving twice is fine. **404** if the listing doesn't exist.

### DELETE /me/saved/:listingId

**204**. Also idempotent.

### GET /me/following

**200** `Storefront[]`: the shops you follow, most recently followed first.

### PUT /me/following/:storefrontId

**204**. Idempotent, and it increases the shop's `followers` count once. **400** for your own shop. **404** if the shop doesn't exist.

### DELETE /me/following/:storefrontId

**204**. Idempotent, and it decreases the count once.

### POST /me/recent

Call this when a listing or shop page opens.

```json
{ "kind": "listing", "id": "l1" }
```

`kind` is `listing` or `shop`; for a shop, `id` is the storefront id. Viewing the same thing again moves it to the top, and only the latest 12 are kept.

**204**. **404** if the listing or shop doesn't exist.

---

## Conversations

In-app chat about an item. The other option is WhatsApp, which the frontend links to directly through `wa.me`; that doesn't involve the API. Every route needs a token, and only the two participants can read or post (**403** for anyone else).

### GET /conversations

**200** `ConversationSummary[]`, most recent activity first. This drives the Messages inbox and the chat bar.

```json
[
  {
    "id": "c2",
    "listingId": "l12",
    "listing": { "id": "l12", "title": "Handmade leather sandals (bulk lot of 12 pairs)", "price": 96000, "currency": "NGN", "…": "…" },
    "withUser": { "id": "u4", "name": "Tunde Bakare", "verified": true, "trustScore": 61, "phone": "+2348105526671", "role": "USER", "memberSince": "2024-01-19T00:00:00.000Z" },
    "whatsappNumber": "+2348105526671",
    "lastMessage": {
      "id": "m5",
      "conversationId": "c2",
      "senderId": "u4",
      "body": "Yes, all 12 available. I can deliver to your Lagos shop this week.",
      "createdAt": "2026-09-06T12:20:00.000Z"
    },
    "lastMessageAt": "2026-09-06T12:20:00.000Z",
    "unread": true
  }
]
```

### POST /conversations

Open a chat with a seller, usually about a listing. If a chat between the two of you about that listing already exists, it is returned instead of a new one, so the "Chat" button can always call this.

```json
{ "withUserId": "u4", "listingId": "l12" }
```

The listing must belong to one of you. A chat displays its listing as the subject, so it can't borrow someone else's, the way a scammer might chat "about" a trusted seller's item.

**200** `ConversationSummary`. **400** if you try to message yourself, or the listing belongs to someone else. **404** if the user or listing doesn't exist.

### GET /conversations/:id

**200** `ConversationSummary` plus `messages`, the latest 50 with the oldest first.

```json
{
  "id": "c2",
  "listingId": "l12",
  "listing": { "…": "Listing" },
  "withUser": { "id": "u4", "name": "Tunde Bakare", "verified": true, "trustScore": 61 },
  "lastMessage": { "id": "m5", "…": "…" },
  "lastMessageAt": "2026-09-06T12:20:00.000Z",
  "unread": true,
  "messages": [
    { "id": "m4", "conversationId": "c2", "senderId": "u1", "body": "Are the sandals still in stock? I'd like all 12 pairs for my storefront.", "createdAt": "2026-09-06T12:00:00.000Z" },
    { "id": "m5", "conversationId": "c2", "senderId": "u4", "body": "Yes, all 12 available. I can deliver to your Lagos shop this week.", "createdAt": "2026-09-06T12:20:00.000Z" }
  ]
}
```

### GET /conversations/:id/messages

| Query | Notes |
| --- | --- |
| `before` | ISO timestamp. Returns messages older than this, for "load earlier". |
| `limit` | 1–100, default 50 |

**200** `Message[]`, oldest first.

### POST /conversations/:id/messages

```json
{ "body": "Can you do ₦90,000 for the lot?" }
```

`body` is 1–2000 characters. The sender is always the signed-in user. Sending a message also marks the chat read for you.

**201** `Message`.

### POST /conversations/:id/read

Call this when a chat is opened. **204**.

---

## Verification

The flow behind the "Get verified" page. It has three steps:

1. Confirm the phone with a code. Signing in already does this.
2. Upload a government ID.
3. Upload a selfie.

Then submit, and a moderator reviews it. Approval sets `verified` on the user and `isVerified` on their shop.

**ID documents are private.** They're sent straight to these endpoints, stored outside the public uploads folder (`PRIVATE_UPLOAD_DIR`), and never get a URL. Only moderators can open them, through [`GET /admin/verifications/:userId/files/:kind`](#get-adminverificationsuseridfileskind).

### GET /me/verification

🔒 **200**

```json
{
  "verified": false,
  "phoneVerified": true,
  "status": "PENDING",
  "hasIdDocument": true,
  "hasSelfie": true,
  "submittedAt": "2026-10-11T20:31:12.000Z"
}
```

`status` is `NOT_STARTED`, `PENDING`, `APPROVED` or `REJECTED`. `reviewNote` is included after a rejection that came with a note.

### POST /me/verification/phone/request

🔒 Texts a code to the account's phone, under the same rules as [sign-in codes](#auth).

**200** `{ "sent": true, "expiresInSeconds": 300, "devCode": "…" }`

### POST /me/verification/phone/confirm

🔒

```json
{ "code": "123456" }
```

**200** with the same body as [`GET /me/verification`](#get-meverification). **400** for a wrong or expired code, **429** after 5 wrong tries.

### POST /me/verification/id-document

🔒 `multipart/form-data`, one field named `file`: a JPEG, PNG, WebP or PDF, up to 5 MB. A new upload replaces the previous one.

**200** with the verification status (`hasIdDocument: true`). **409** while a review is pending or once you're verified. **415** for any other file type.

### POST /me/verification/selfie

🔒 The same, for the selfie: a JPEG, PNG or WebP (no PDF).

**200** with the verification status (`hasSelfie: true`). **409** and **415** as above.

### POST /me/verification/submit

🔒 No body. Sends your documents to the review queue.

**200** with the verification status, now `PENDING`. **400** `"Confirm your phone number first"` or `"Upload your ID and a selfie first"`. **409** if a review is already pending or you're verified. Resubmitting after a rejection is allowed.

### GET /admin/verifications

🛡 `?status=PENDING|APPROVED|REJECTED` (default `PENDING`). Oldest submissions first.

**200**

```json
[
  {
    "userId": "u5",
    "user": { "id": "u5", "name": "Grace Achieng", "phone": "+254733209481", "…": "PublicUser" },
    "status": "PENDING",
    "idDocument": "/api/admin/verifications/u5/files/id",
    "selfie": "/api/admin/verifications/u5/files/selfie",
    "submittedAt": "…"
  }
]
```

Moderators always see the person's phone: it's what the documents are checked against.

### GET /admin/verifications/:userId/files/:kind

🛡 `kind` is `id` or `selfie`. Streams the file with its type, and with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so it's never cached, framed or run.

**200** the file. **400** for an unknown `kind`. **404** if there's no such document.

### POST /admin/verifications/:userId/approve

🛡 The body is optional: `{ "note": "Matches ID" }`, at most 500 characters.

**200** `{ "userId": "u5", "status": "APPROVED" }`. **404** if there's no pending verification for that user.

### POST /admin/verifications/:userId/reject

🛡 `{ "note": "The ID photo is blurry, please retake it." }` is optional. The user sees the note in `reviewNote`.

**200** `{ "userId": "u5", "status": "REJECTED" }`.

---

## Uploads and health

### POST /uploads

🔒 `multipart/form-data` with a single field named `file`: a public photo (JPEG, PNG or WebP), up to 5 MB. PDFs and other types get a **415**: nothing but photos is ever public, so Sokoni's domain can't be used to host a fake "payment form". ID documents go to [verification](#verification) instead.

```bash
curl -H "Authorization: Bearer $TOKEN" -F "file=@photo.jpg" http://localhost:4000/api/uploads
```

**201**

```json
{ "path": "/uploads/9b1d6c2e-4f1a-4c8e-9d7b-2a6e5f3c1b0d.jpg", "mimeType": "image/jpeg", "size": 184233 }
```

Put the `path` into a listing's or product's `images`, a shop's `logoUrl` or `coverUrl`, or `avatarUrl`. Those fields accept only such paths: no third-party URLs, which could carry tracking pixels.

Photos are served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so a crafted file can't run as a page. Files are stored on local disk in `UPLOAD_DIR` for now.

### GET /health

**200** `{ "status": "ok", "database": "up", "time": "2026-10-11T20:40:00.000Z" }`

---

## How the web app uses this API

The Sokoni web app (`Monorepo frontend`, Next.js) is wired to the endpoints here. It talks to the API in two ways:

- **Server Components** fetch directly from `SOKONI_API_URL` with the visitor's token (`src/lib/api/server.ts`). Public pages are rendered on the server from live data; nothing is cached across requests.
- **The browser never calls the API directly.** It calls the web app's own `/api/*` route (`src/app/api/[...path]/route.ts`), which forwards to this API and adds `Authorization: Bearer …` from an httpOnly cookie. Page scripts can never read the token, and the API needs no CORS for the web app.

A few more details:

- **Signing in** goes through the web app's `/auth/session` route. It calls `POST /auth/otp/verify` and stores the token in that cookie. The proxy refuses `/api/auth/otp/verify`, so page scripts can't fetch a token.
- **Uploaded files** are served at the web app's `/uploads/*` too, so records keep relative paths.
- **Client IP.** The web app forwards each visitor's IP in `X-Forwarded-For`. Set `TRUST_PROXY` here to the hops you run (default `loopback`), so rate limits apply per visitor rather than to the web server.

| Endpoint | Used by (in `Monorepo frontend/src`) |
| --- | --- |
| `POST /auth/otp/request` | `app/signin/signin-form.tsx` |
| `POST /auth/otp/verify` | `app/auth/session/route.ts` (sign-in) |
| `GET /me`, `GET /me/storefront`, `GET /me/library` | `getSession()` in `lib/api/server.ts`, loaded by the root layout |
| `GET /listings`, `GET /storefronts`, `GET /categories` | Home (`app/page.tsx`), category pages, search browse |
| `GET /listings/:id`, `GET /listings/:id/related` | `app/listing/[id]/page.tsx` |
| `POST /listings`, `POST /storefronts/:id/products`, `POST /uploads` | `app/post/post-wizard.tsx`, `lib/image.ts` |
| `PATCH /listings/:id`, `POST /listings/:id/renew` | `app/dashboard/listings/listings-view.tsx` |
| `POST /listings/:id/reports` | `components/report-dialog.tsx` |
| `GET /storefronts/:slug`, `GET /storefronts/:slug/products` | `app/s/[slug]/page.tsx`, the shop editor |
| `POST /storefronts` | `app/onboarding/onboarding-wizard.tsx` |
| `PATCH /storefronts/:id`, `PATCH /products/:id` | `app/dashboard/storefront/storefront-editor.tsx` |
| `GET /users/:id` and its `/listings`, `/storefront` and `/reviews` | Profile, listing and shop pages |
| `GET /search` | `app/search/page.tsx` |
| `GET /me/dashboard`, `GET /me/listings` | The seller hub, and the sidebar's "My ads" |
| `PUT` and `DELETE /me/saved/:id`, `PUT` and `DELETE /me/following/:id`, `POST /me/recent` | `lib/session.tsx` (save, follow, recently viewed) |
| `/conversations` and its children | `lib/chat-store.ts`, behind the chat bar, chat panel and Messages inbox. There's no push channel yet, so what's on screen polls while the tab is visible: the list every 20s, an open thread every 8s. |
| `/me/verification/*` | `app/verify/verify-wizard.tsx`, `lib/image.ts` (`uploadVerificationFile`) |

Not used by the web app yet:

- `DELETE /products/:id` and `POST /users/:id/reviews`, which have no controls yet.
- `GET /me/saved` and `GET /me/following`, because the library covers them.
- The `/admin` moderation endpoints, which have no screens yet.
