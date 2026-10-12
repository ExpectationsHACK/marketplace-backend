# Sokoni API — working guide

The backend for Sokoni, a marketplace for African sellers. One seller identity runs both one-off classified ads and an always-on WhatsApp shop, and carries a trust score and ID verification. Buyers and sellers deal on WhatsApp or in the in-app chat; there is **no escrow and no in-app payment**.

- `SYSTEM.md`: how the whole system fits together (web app, API, storage, security model, deployment).
- `DESIGN.md`: the API's design rules: resource shapes, errors, auth, privacy.
- `API.md`: every endpoint with real examples.
- This file: how to work in the code without breaking any of them.

The web app lives in `../Monorepo frontend` (Next.js). It's the only intended client.

## Commands

```bash
npm run start:dev      # watch mode, http://localhost:4000/api (Swagger at /api/docs in development)
npm run build          # compile to dist/
npm test               # unit tests (src/**/*.spec.ts)
npm run test:e2e       # the whole API over HTTP against a fresh, seeded test.db
npm run lint           # oxlint, type-aware; must be clean
npx tsc --noEmit -p tsconfig.json
npm run db:seed        # wipe and reload the demo data (the frontend's fictional seed)
npm run db:reset       # drop, re-migrate, seed
```

Before calling anything done: `npx tsc --noEmit -p tsconfig.json && npm run lint && npm test && npm run test:e2e && npm run build`.

## Stack

- **NestJS 12, ESM.** Imports need `.js` suffixes; `module`/`moduleResolution` are `nodenext`; TypeScript 6, target ES2023.
- **Prisma 7** with a driver adapter (`PrismaBetterSqlite3`) on SQLite. The client is generated into `src/generated/prisma`, which is gitignored: run `npm run db:generate` after schema changes and on fresh clones.
- **Vitest 4** for unit and e2e tests (supertest), **oxlint** for lint.
- `class-validator` DTOs with a global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`.
- `@nestjs/throttler` (in-memory), `@nestjs/jwt` (HS256), `@nestjs/swagger` (the CLI plugin reads DTOs and doc comments).

## Layout

```
prisma/schema.prisma        data model; migrations in prisma/migrations; seed.ts + seed-data.json
src/main.ts                 configureApp(): prefix, trust proxy, static /uploads with hardened headers, CORS, validation;
                            bootstrap(): Swagger (if SWAGGER_ENABLED), listen. Tests call configureApp too.
src/app.module.ts           config, JWT, throttler, the global AuthGuard, feature modules
src/config/env.ts           validateEnv(): every variable checked at boot, with every problem listed
src/common/                 auth (guard + decorators), mappers (response shapes + sellerIdsAmong), dto (paging,
                            IMAGE_URL_PATTERN), categories, phone, errors
src/<feature>/<feature>.module.ts   one file per feature: DTOs, service, controller, module
src/uploads/file-store.ts   FileStore: public photos vs private documents, byte sniffing
test/app.e2e-spec.ts        end-to-end suite, including a "security" describe block
```

Features: `auth` (phone + one-time code), `listings`, `storefronts` (+ products), `users` (profiles, reviews), `search` (+ categories), `me` (profile, dashboard, library), `conversations`, `verification` (+ admin review), `uploads` (+ health).

## Rules you must not break

**Access and privacy**
1. **Public by default, private by rule.** Routes are public unless `@RequireAuth()` or `@RequireRoles()`. A bad token is always a 401, even on a public route. The guard re-reads the user on every request, so role changes and deletions apply at once.
2. **Phone numbers.** A person's phone is public only if they sell (they run a shop or have a live listing). Build users with `toPublicUser(row, showPhone)` and decide `showPhone` with `sellerIdsAmong()`. Pass `true` only for sellers, for the person themselves (`toMe`), or for moderators. Never return a buyer's number.
3. **Owners change their own things.** Shops and products: owner only, staff included. Listings: the seller edits; moderators may only set `status` to `REMOVED` (sets `takenDownAt`) or `ACTIVE` (clears it). While `takenDownAt` is set, the seller can't edit, relist or renew. Check ownership in the service before any write.
4. **Files.**
   - Public uploads are photos only (JPEG, PNG, WebP), served with `nosniff` and `CSP: default-src 'none'; sandbox`.
   - ID documents and selfies go through `FileStore.savePrivateDocument` into `PRIVATE_UPLOAD_DIR` and are only streamed to moderators.
   - Image fields accept only `IMAGE_URL_PATTERN` (an `/uploads/<uuid>.<jpg|png|webp>` path): never third-party URLs, never PDFs.
   - Always sniff bytes; never trust the client's content type or file name.
5. **Trust signals aren't self-declared.** `trustScore`, `verified`, `isVerified`, `featured`, `plan`, `followers`, `responseRate` and `responseTime` are never writable by their owner. Don't add them to a DTO.
6. **Rate limits.** Every write that costs us something or could be spammed gets a route `@Throttle` (see `API.md` conventions). One-time codes are also capped per phone number (`OtpService`), because IP limits alone can be dodged.

**Code**
7. **DTO instances carry every declared field.** At target ES2023, class fields are defined on every instance, set to `undefined` when not sent. So `'price' in dto` and `Object.keys(dto)` lie. Test values instead: `dto.price !== undefined` means sent, and `null` means cleared. This bug once wiped prices on "mark as sold".
8. **Shapes come from `common/mappers.ts`.** Optional fields are omitted, not `null`. Field names follow the web app's `src/lib/types.ts`; change both together, and `API.md`.
9. **Errors.** Throw Nest HTTP exceptions with a person-readable `message`. The web app shows 4xx messages verbatim, so write them for people. Add a `code` only when the UI must branch on it (`NAME_REQUIRED`, `STOREFRONT_EXISTS`, `NO_STOREFRONT`). Catch unique violations with `isUniqueViolation()` and rethrow anything else.
10. **Expiry is computed** (`effectiveStatus`, `liveListingWhere`), never stored; public feeds always filter with `liveListingWhere()`.
11. **No invented claims.** Seed data is fictional, and must stay so. No user counts, prices or limits the product hasn't decided.

## Changing the schema

`prisma migrate dev` prompts, and fails in non-interactive shells. Generate the SQL instead:

```bash
mkdir prisma/migrations/<timestamp>_<name>
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script > prisma/migrations/<timestamp>_<name>/migration.sql
npx prisma migrate deploy && npm run db:generate
```

Keep the schema portable to Postgres: no scalar lists, and keep `Int` prices within 32 bits (or move them to `BigInt`) before switching.

## Testing

- Unit tests sit beside the code (`*.spec.ts`) and cover pure rules: phone numbers, slugs, search, expiry, env validation, file sniffing.
- The e2e suite drives the real HTTP pipeline. It runs in order against one database (`fileParallelism: false`); throttling is skipped when `NODE_ENV=test`.
  - Sign in with the `signIn(phone, name?)` helper. It caches sessions per phone because of the 30-second code cooldown.
  - New security behaviour gets a test in the `security` block, written as the attack it stops.
- Test files use `test.db`, `test-uploads/` and `test-private-uploads/`, all wiped by `test/global-setup.ts`.
