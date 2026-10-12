# Sokoni API

The backend for Sokoni, a marketplace for African sellers that puts one-off classifieds and an always-on WhatsApp shop under one seller identity, with a trust score and ID verification attached to the person.

It is built with NestJS 12, Prisma 7 and SQLite, and serves the Sokoni web app (`Monorepo frontend`). The web app's server calls this API directly, and browsers reach it through the web app's `/api` proxy, so run both:

1. This API on port 4000.
2. Then `npm run dev` in the web app.

- **[API.md](API.md)** lists every endpoint with real request and response examples, and shows where the web app uses each one.
- **[SYSTEM.md](SYSTEM.md)** covers how the web app, API, database and files fit together, the security model, and what production needs.
- **[DESIGN.md](DESIGN.md)** gives the API's design rules: shapes, errors, auth and privacy.
- **[CLAUDE.md](CLAUDE.md)** is the working guide for changing the code.
- **Swagger UI** is served at <http://localhost:4000/api/docs> while the server runs.

## Run it

You need Node 24 and npm 11.

```bash
npm install
cp .env.example .env          # then set JWT_SECRET
npm run db:migrate            # creates dev.db and applies migrations
npm run db:generate           # generates the Prisma client into src/generated/prisma
npm run db:seed               # loads the frontend's demo data
npm run start:dev             # http://localhost:4000/api
```

### Sign in as the demo seller

Sign-in is by phone number with a one-time code. No SMS provider is connected yet, so the code is printed in the server log. With `OTP_DEV_ECHO=true` the response also includes it as `devCode`.

```bash
curl -s -X POST localhost:4000/api/auth/otp/request -H "content-type: application/json" -d '{"phone":"+234 802 314 8890"}'
# {"sent":true,"expiresInSeconds":300,"devCode":"478977"}
curl -s -X POST localhost:4000/api/auth/otp/verify -H "content-type: application/json" -d '{"phone":"+234 802 314 8890","code":"478977"}'
# {"accessToken":"eyJ…","tokenType":"Bearer","isNewUser":false,"user":{"id":"u1","name":"Amara Chukwu",…}}
```

`+234 802 314 8890` is Amara (`u1`), the frontend's signed-in demo user, who has a shop, listings and chats. Any other number creates a new account when you send a `name` along with the code.

The seed has no admin. To review ID verifications, open `npx prisma studio` and set a user's `role` to `ADMIN` or `MODERATOR`, then sign in again.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run start:dev` | Runs the server with watch mode |
| `npm run build` then `npm run start:prod` | Compiles to `dist/` and runs it |
| `npm test` | Unit tests for the pure rules: phone numbers, slugs, search, expiry and env validation |
| `npm run test:e2e` | The whole API against a fresh, seeded `test.db`, through the real HTTP pipeline |
| `npm run lint` | oxlint, type-aware |
| `npm run db:migrate` | Creates a migration from schema changes and applies it |
| `npm run db:generate` | Regenerates the Prisma client after schema changes |
| `npm run db:seed` | Wipes the data and reloads the demo data |
| `npm run db:reset` | Drops the database, reapplies every migration, then seeds |

## How it is put together

```
prisma/
  schema.prisma        the data model (users, shops, products, listings, chats, reviews, saves, follows, verification, OTP codes, reports)
  seed-data.json       the frontend's mock data, same ids
  seed.ts              loads it
src/
  main.ts              bootstrap: /api prefix, CORS, validation, /uploads static files, Swagger
  app.module.ts        config, JWT, rate limits, the global auth guard
  config/env.ts        environment validation
  common/              auth guard and decorators, response mappers, shared DTOs, categories, phone numbers
  auth/                phone + one-time-code sign-in
  listings/            classifieds: browse, post, edit, mark sold, renew, report
  storefronts/         WhatsApp shops and their products
  users/               public profiles, a person's listings and shop, reviews
  search/              search with a top result; listing categories
  me/                  my profile, shop, listings, dashboard, saved items, follows, recently viewed
  conversations/       in-app chat about an item
  verification/        phone confirmation, ID + selfie submission, moderator review
  uploads/             photo and document uploads; health check
test/
  app.e2e-spec.ts      end-to-end suite
```

Each feature is a single `*.module.ts` holding its DTOs, service, controller and module.

**Rules that hold everywhere**

- **Public by default.** Endpoints are public unless marked `@RequireAuth()` or `@RequireRoles(...)`. A bad token is always a 401, even on a public route, so an expired session shows up instead of quietly turning into a signed-out view. The user is re-read from the database on every request, so a role change or deleted account takes effect immediately.
- **Strict validation.** Request bodies are validated and whitelisted, and an unknown field is a 400.
- **Response shapes.** Responses follow the frontend's `src/lib/types.ts`: optional fields are omitted rather than `null`, prices are integers in whole currency units, and listings embed a small `seller` summary for the trust ring.
- **Expiry is computed.** A listing is live when it is `ACTIVE` and before its `expiresAt` (30 days after posting). `EXPIRED` is never stored, so nothing has to run on a schedule.
- **Upload checks.** Uploads are checked by their bytes, not their file name, at most 5 MB. Public uploads are photos only (JPEG, PNG, WebP). ID documents and selfies, which may also be PDFs, go to a private folder that only moderators can read, through the API.
- **Privacy.** A person's phone number is public only once they sell (a shop or a live listing). Trust signals (trust score, verification, response time, followers) can't be set by their owner.
- **No payments.** Sokoni takes no payments and there is no escrow. Buyers and sellers deal on WhatsApp or in the in-app chat.

## Not built yet

| Area | Today | To do |
| --- | --- | --- |
| SMS | Codes go to the server log. | Send them through an SMS or WhatsApp provider in `OtpService.issue` (`src/auth/otp.service.ts`). |
| Database | SQLite file | Use Postgres. See below. |
| File storage | Local disk (`UPLOAD_DIR`) | Use object storage such as S3 or Supabase Storage. Only the upload handler in `src/uploads/uploads.module.ts` changes, because records store URLs. |
| Sessions | One 7-day access token; signing out only deletes the cookie | Refresh tokens, and server-side revocation (a token version on the user) for sign-out-everywhere. |
| Reviews | Anyone signed in can review any seller | Allow reviews only after a real conversation or deal with that seller. |
| Shop WhatsApp number | Changing it needs no confirmation | Confirm the new number with a one-time code: buyers pay through it. |
| Rate limits | In memory, per process | A shared store (Redis) once there's more than one API process. |
| Custom domains | Saved as `PENDING` | Check DNS and issue SSL certificates, then set `VERIFIED`. |
| Plans | `plan` is stored and shown | Billing. No prices or limits have been decided, so none are enforced. |
| Live chat | The web app polls for new messages while a chat is on screen | Push them over WebSockets or server-sent events. |
| Moderation screens | Verification review exists only as `/admin` endpoints | An admin page in the web app. |

### Moving to Postgres

The schema avoids SQLite-only features: there are no scalar lists, and image lists use child tables. The switch takes four steps:

1. In `prisma/schema.prisma`, set `provider = "postgresql"`.
2. Run `npm install @prisma/adapter-pg`. In `src/prisma/prisma.service.ts`, replace `PrismaBetterSqlite3({ url })` with `PrismaPg({ connectionString: url })`.
3. Point `DATABASE_URL` at Postgres, delete `prisma/migrations`, and run `npm run db:migrate` to create a fresh initial migration. The SQL in the current migration is SQLite-specific.
4. Make text search case-insensitive. SQLite's `LIKE` already ignores case for ASCII, but Postgres's doesn't. Add `mode: 'insensitive'` to the `contains` filters in `listings`, `storefronts` and `search`, or switch to full-text search.
