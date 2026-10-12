# Sokoni API — design

How the API looks from the outside, and why. `API.md` lists every endpoint. This file holds the rules those endpoints follow, so new ones fit.

## Principles

1. **The web app's shapes are the contract.** Responses mirror the frontend's `src/lib/types.ts`, field for field. A screen should never need to reshape what it gets.
2. **One request per screen where it matters.** Listings embed a seller summary for the trust ring, chats embed their listing and the other person, and the library embeds its records. Embedding beats a second round trip on mobile data.
3. **Private by rule, not by accident.** What's public is decided per field. A buyer's phone, an ID document and an email address stay with the people who need them. See [Privacy](#privacy).
4. **Trust signals are earned, not typed.** A person can't write their own trust score, verification, response time or follower count.
5. **Say what happened, in words people can read.** Every error message is fit to show a user, because the web app shows it.

## Resources and URLs

- **Base path `/api`.** Plural nouns: `/listings`, `/storefronts`, `/products`, `/users`, `/conversations`.
- **`/me/...`** is everything about the signed-in person: profile, shop, listings, dashboard, library and verification. It never takes a user id.
- **Admin routes live under `/admin/...`**, behind roles.
- **Ids are opaque strings** (CUIDs; the seed keeps the frontend's `u1`, `l1`…). Shops are addressed by slug for reading (`/storefronts/:slug`, as in shareable links) and by id for writing (`PATCH /storefronts/:id`), so a rename can't break a write.
- **Actions that aren't plain field edits are sub-resources posted to:** `/listings/:id/renew`, `/listings/:id/reports`, `/conversations/:id/read`, `/me/verification/submit`.
- **Membership toggles are idempotent `PUT`/`DELETE` on the pair:** `PUT /me/saved/:listingId`, `DELETE /me/following/:storefrontId`. Doing it twice is fine.

## Methods and status codes

| Situation | Answer |
| --- | --- |
| Read | `GET` → 200 |
| Create | `POST` → 201 with the record |
| Open-or-reuse (`POST /conversations`), state changes posted as actions (renew, submit, approve) | 200 with the record |
| Partial edit | `PATCH` → 200 with the full updated record. Fields left out don't change; `null` clears a nullable field |
| Toggle, delete, mark read, record a view | 204, no body |
| Bad input | 400, with `message` as a list when validation fails |
| Not signed in, or a token we won't honour | 401 |
| Signed in but not allowed | 403 |
| Not found, or hidden from you (a removed listing) | 404 |
| Duplicate or conflicting state | 409 |
| Wrong kind of file | 415 |
| New account needs a name | 422 with `code: "NAME_REQUIRED"` |
| Too many requests | 429 |

## Shapes

- **Field names are camelCase** and match the web app.
- **Dates are ISO 8601 strings in UTC.**
- **Money is an integer in whole currency units, plus a `currency` code** (`NGN`, `GHS`, `KES`, `UGX`). There are no floats. No price means "contact for price".
- **Optional fields are omitted, never `null`.** The exceptions are the dashboard's stats, where `null` means "you have no shop".
- **Computed values are computed:** a listing reads `EXPIRED` once past `expiresAt`, and nothing stores it.
- **Collections:** feeds that can grow are paged as `{ items, total, page, limit }` (`?page=&limit=`, at most 50); small bounded lists come back as plain arrays.
- **People appear at three levels of detail:**
  - `SellerSummary` (name, avatar, verified, trust score) on cards, chats and reviews;
  - `PublicUser` (plus role, member since, response time, and phone if they sell) on profiles;
  - `MeUser` (plus phone, email, phone verified) only for yourself.

## Errors

```json
{ "statusCode": 404, "error": "Not Found", "message": "Listing not found" }
```

- `message` is written for people: "You can't review yourself", not "invalid reviewer".
- `code` is added only when a client must branch on it: `NAME_REQUIRED`, `STOREFRONT_EXISTS` (with the existing `slug`), `NO_STOREFRONT`.
- Server errors never leak internals. Nest's default 500 body is generic, and the web app replaces 5xx messages with its own copy.

## Authentication and roles

- **Sign-in is a phone number plus a 6-digit one-time code.** There are no passwords. The same flow creates accounts and needs a `name` the first time.
  - The "name required" answer comes only after the code checks out, so it can't reveal which numbers have accounts.
  - Codes are HMAC-hashed, last 5 minutes, allow 5 tries and work once. Each number gets one every 30 seconds and at most 5 an hour.
- **A successful sign-in returns a JWT** (HS256, 7 days) as `Authorization: Bearer`. The web app keeps it in an httpOnly cookie and never shows it to page scripts.
- **Roles are `USER`, `MODERATOR` and `ADMIN`,** granted only in the database for now. Staff can review verifications and take listings down or restore them. They can't edit what sellers wrote, and can't touch shops.

## Privacy

| Data | Who sees it |
| --- | --- |
| Phone number | The person; anyone, once the person sells (a shop or a live listing); moderators reviewing their verification |
| Email | The person |
| ID document, selfie | Moderators, streamed through `/admin/verifications/:userId/files/:kind`, never cached, never given a URL |
| Chats | The two participants |
| Reports | Stored for the trust team; the seller isn't told who reported |
| Saved items, follows, recently viewed | The person |

Image fields take only Sokoni-hosted photo paths, so no record can embed a third-party tracking pixel.

## Rate limiting

- **Per client IP:** 120 requests a minute overall, plus tighter limits on writes that cost money or invite spam. The full list is in `API.md`.
- **Per phone number:** one-time codes, so rotating IPs doesn't help.
- **Behind a proxy:** the API trusts `X-Forwarded-For` only from the hops in `TRUST_PROXY`.

## Evolving the API

- **Additive changes are free:** new fields and new endpoints.
- **Renaming or removing a field, or changing what a status code means, is breaking.** Do it in the web app in the same change, and update `API.md`. There's a single client today; once there are more, version under `/api/v2` instead of breaking `/api`.
- **Keep `API.md` honest.** Its examples are captured from a running server; re-capture them when a shape changes.
