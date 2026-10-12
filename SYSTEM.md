# Sokoni — system overview (from the API's side)

Sokoni is two applications. The web app has its own `SYSTEM.md`, written from the browser's side; together, the two files describe the whole system.

| Part | Repository | Runs | Job |
| --- | --- | --- | --- |
| Web app | `Monorepo frontend` (Next.js 16) | Node, port 3000 | Renders every page on the server, proxies the browser's API calls, holds the session cookie |
| API | `Monorepo Backend` (this repo, NestJS 12) | Node, port 4000 | All data, rules and files. The only thing that touches the database |
| Database | SQLite file today (`DATABASE_URL`), Postgres later | — | Users, shops, listings, chats, reviews, verification, codes |
| Files | `UPLOAD_DIR` (public photos), `PRIVATE_UPLOAD_DIR` (ID documents) | Local disk today | Uploaded images and documents |

```
 Browser ──HTTPS──▶ Web app (Next.js) ──HTTP, private network──▶ API (NestJS) ──▶ Database
   │                  │ pages: server-rendered, call the API         │            └──▶ uploads/  (public photos)
   │                  │ /api/*: proxy, adds Bearer from cookie       │            └──▶ private-uploads/ (ID docs)
   │                  │ /auth/session: sign-in sets httpOnly cookie  │
   │                  │ /uploads/*: serves public photos             │
   └── never talks to the API directly ──────────────────────────────┘
```

## Inside the API

**A request goes through, in order:**

1. Express, with `trust proxy` (`TRUST_PROXY`).
2. Static `/uploads`, for public photos only.
3. The throttler guard, which limits per client IP, with tighter limits on some routes.
4. The auth guard. It verifies any bearer token, re-reads the user, and enforces `@RequireAuth` and `@RequireRoles`.
5. The validation pipe, which whitelists fields, rejects unknown ones, and transforms types.
6. The controller and its service, using Prisma.
7. The mappers, which build response shapes and apply the privacy rules.
8. Nest's exception layer, which gives a consistent error body.

**Modules:**

| Module | Owns |
| --- | --- |
| `auth` | Phone sign-in: one-time codes (`OtpService`, HMAC-hashed, capped per number) and JWT issue |
| `listings` | Classifieds: browse/filter/sort, post, edit, mark sold, renew, report, moderator takedown |
| `storefronts` | WhatsApp shops and their products (owner-only writes) |
| `users` | Public profiles, a person's listings, shop and reviews |
| `search` | Search with a top result, categories with live counts and cities |
| `me` | The signed-in person: profile, shop, listings, dashboard, library (saved, following, recently viewed) |
| `conversations` | In-app chat about an item: open-or-reuse, messages, read state |
| `verification` | Phone confirmation, private ID and selfie upload, submission, moderator review and file access |
| `uploads` | `FileStore` (public photos vs private documents, byte sniffing), `POST /uploads`, `GET /health` |

**Data model, in brief:**

- A `User` has at most one `Storefront`, which has `Product`s, and many `Listing`s.
- `Listing`s and `Product`s have ordered image rows.
- `Conversation`s have two `ConversationParticipant`s (with `lastReadAt`) and `Message`s.
- `Review`s are one per reviewer per seller.
- `SavedListing`, `Follow` and `RecentView` make up the library.
- `Verification` is one per user, holding private file keys and a review state.
- `OtpCode` and `Report` complete the model.

Listing expiry is computed from `expiresAt`, and moderator takedowns are recorded in `takenDownAt`.

## Identity and sessions

1. The phone number is the identity. `POST /auth/otp/request` creates a 6-digit code and delivers it. Today that means the server log, plus the response in development only. The code expires in 5 minutes; a number can get one every 30 seconds and 5 an hour.
2. `POST /auth/otp/verify` checks the code (5 tries), creates the account on first sign-in (a name is required), and marks the phone verified. It returns a 7-day HS256 JWT holding `sub` and `role`.
3. The web app stores that token in an httpOnly cookie. On every request the guard re-reads the user, so a deleted account or changed role applies at once. A token the API refuses is a 401 even on public routes; the web app then retries without it and clears the cookie.
4. There are no refresh tokens and no server-side revocation yet. Signing out deletes the cookie, but a stolen token stays valid until it expires.

## Security model

| Threat | Defence |
| --- | --- |
| Someone reads another person's phone number | Phones are public only for sellers (`sellerIdsAmong`); buyers' numbers never leave the API |
| ID documents leak | Private folder, no URLs, moderator-only streaming with `no-store` and a sandbox CSP; startup refuses a private folder inside the public one |
| Sokoni's domain hosts phishing files | Public uploads are photos only; PDFs exist only as private documents |
| A crafted "photo" runs as a page | Byte sniffing on upload; served with `nosniff` and `CSP: default-src 'none'; sandbox` |
| Tracking pixels or third-party content in listings | Image fields take only `/uploads/<uuid>.<jpg|png|webp>` paths |
| Brute-forcing a one-time code, or texting a victim repeatedly | 5 tries per code; 1 code per 30 seconds and 5 per hour per number; IP limits on top |
| "Is this number registered?" probing | The "name required" answer comes only after a correct code |
| A chat that borrows a trusted seller's listing | The listing must belong to one of the two people |
| A seller undoing a moderator's takedown | `takenDownAt` locks the listing against the seller until a moderator restores it |
| Staff (or a stolen staff account) changing a shop's WhatsApp number | Shops and products are owner-only, staff included |
| Self-awarded trust | Trust score, verification, response time, followers, featured and plan aren't writable by their owner |
| Mass assignment, odd input | Whitelisting validation pipe; unknown fields are a 400 |
| Spam and floods | Per-route throttles on writes; global per-IP limit |
| Forged client IPs | `X-Forwarded-For` is honoured only from `TRUST_PROXY` hops |

**Known gaps** (see `README.md`, "Not built yet"):

- No token revocation.
- Reviews don't require a completed deal.
- A shop's WhatsApp number can change without confirming the new number.
- Domain reservations aren't verified, so a domain can be squatted.
- Rate limits are in memory, per process.
- Photos uploaded straight to the API keep their metadata (the web app strips it before upload).

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | Required. `file:./dev.db` for SQLite |
| `JWT_SECRET` | — | Required, at least 32 characters. Also keys the code hashes |
| `JWT_EXPIRES_IN` | `7d` | |
| `PORT` | `4000` | |
| `FRONTEND_ORIGIN` | `http://localhost:3000` | CORS. The web app proxies, so browsers don't need it |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | |
| `UPLOAD_DIR` | `./uploads` | Public photos |
| `PRIVATE_UPLOAD_DIR` | `./private-uploads` | ID documents; must not be inside `UPLOAD_DIR` |
| `OTP_DEV_ECHO` | `false` | Returns codes in responses. Refused when `NODE_ENV=production` |
| `TRUST_PROXY` | `loopback` | Which hops may set `X-Forwarded-For` |
| `SWAGGER_ENABLED` | on, off in production | `/api/docs` |

## Running it in production

Before real users, all of these are required:

1. **Keep the API off the public internet.** Only the web app should reach it. Set `TRUST_PROXY` to the web app's address range.
2. **Put the web app behind a proxy or load balancer that appends `X-Forwarded-For`,** and terminate HTTPS there. Otherwise every visitor shares the web server's rate limit, or can forge their own address.
3. **Secrets:** a long random `JWT_SECRET`, `OTP_DEV_ECHO=false`, `NODE_ENV=production`.
4. **Postgres** instead of SQLite, with backups. See the README for the switch.
5. **Object storage** for both upload folders; documents in a private bucket.
6. **An SMS or WhatsApp provider** in `OtpService.issue`, with spend alerts, since toll fraud targets one-time-code endpoints.
7. **A shared rate-limit store,** such as Redis, once there's more than one API process.

**Observability today:**

- Nest's logger writes to stdout.
- `GET /api/health` checks the database and is safe for load balancers.
- There's no metrics or tracing yet.
