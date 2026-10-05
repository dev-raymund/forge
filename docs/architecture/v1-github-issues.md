# Forge CMS V1 — GitHub Issues

Derived from [v1-build-plan.md](v1-build-plan.md). There are 56 issues in 13 milestones (M0–M12, one per phase). Each issue is a logical engineering task: roughly 2–5 days for one engineer.

**Labels:**
- `area:<module>`: `platform`, `auth`, `tenancy`, `sites`, `domains`, `content`, `editor`, `media`, `navigation`, `seo`, `rendering`, `themes`, `api`, `billing`, `audit`, `ops`
- `type:feature`, `type:infra`, `type:spike`, `type:test`
- `risk:high` for issues on the critical path or with unknowns

**Global acceptance criteria.** These apply to every issue and are not repeated below:
- Typecheck, lint (including module-boundary rules) and all tests pass in CI.
- Every new tenant table uses the tenant column and policy helpers (`orgColumns()`/`siteColumns()`, `tenantPolicy()`; `tenantTable()` was replaced in M1-1), is classified in `src/platform/db/table-classes.ts`, has RLS + FORCE, and is covered by the isolation suite.
- Every mutation checks permissions in the service and writes an audit row in the same transaction.
- No DB access outside repositories, queries or `platform/db`. No business logic in `app/`.
- New migrations are generated, reviewed and backward-compatible.

---

## M0 — Repository & spikes

### M0-1 · Scaffold the repository and CI
**Labels:** `area:platform` `type:infra`

**Description:** Create the Next.js 16 App Router project with the agreed tooling and folder skeleton (§18 of the plan).

**Depends on:** —

**Acceptance criteria:**
- [x] Next.js 16, React 19, TypeScript strict, `@/` path alias, Tailwind 4, shadcn/ui initialised with base components (button, input, dialog, dropdown, table, toast)
  - *Done:* Next 16.3.7, React 19.3, TS 5.9 strict (+ `noUncheckedIndexedAccess`), shadcn `radix-nova`; toast is shadcn's `sonner`.
- [x] Folder skeleton: `src/app/(admin)`, `src/app/(sites)/render/[host]`, `src/modules`, `src/platform`, `src/blocks`, `src/themes`, `src/components`, `tests/`
  - *Note:* `platform/`, `blocks/` and `themes/` appear with their first real code (M1-1, M0-5, M4-4). The plan's folder-hygiene rule (§31) forbids empty placeholder folders.
- [x] ESLint with `no-restricted-imports` boundary rules: modules imported only via `index.ts`/`shared.ts`; `platform/db` only from repositories, queries and platform
  - *Clarified:* services must open transactions (`withTenant`, plan §5.3), so the rule protects the **raw client** (`@/platform/db/client`, private to `platform/`). `app/` and `components/` may not import `@/platform/db`, Drizzle or `pg` at all. Better Auth is restricted to `modules/auth`.
- [x] Vitest (unit + integration projects) and Playwright configured, one smoke test each
- [x] `docker-compose.yml` with Postgres 17, MinIO and Mailpit; `npm run dev:services`
  - *Changed:* MinIO no longer publishes community images (`minio/minio` is gone from Docker Hub), so the S3 stand-in is **RustFS 1.0** (Apache-2.0, MinIO-compatible). Also added **PgBouncer in transaction mode** in front of Postgres, so local and CI runs exercise Neon's pooled-endpoint semantics (needed by M0-3).
- [x] GitHub Actions: typecheck → lint → unit → integration (Postgres + MinIO services) → build → E2E smoke
  - *Pending:* the workflow is written but hasn't run on GitHub yet (no remote). Every step passes locally.
- [x] `README.md` with local setup; `.env.example` with names and explanations only

**Likely files/modules:** `package.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `docker-compose.yml`, `.github/workflows/ci.yml`

**Testing:** CI green on an empty feature set; a boundary-rule violation fixture fails lint.

### M0-2 · Provision environments and domains
**Labels:** `area:ops` `type:infra`

> *Deployment updated 2026-10-01 (ADR 0006, plan §0): V1 runs on one host, `cms.forgelinetechnologies.com`, on free tiers. Tenant sites live at `/s/{address}`, media at `/media`. Custom domains and wildcard hosts are post-V1 infrastructure.*

**Description:** Create the zero-cost V1 deployment (development / private beta) so every later phase deploys to real services.

**Depends on:** M0-1

**Acceptance criteria:**
- [ ] Vercel **Hobby** project connected to the repo (Fluid compute on; region chosen next to Neon; previews on PRs). Hobby is non-commercial only: live billing needs a paid plan
- [ ] Neon **Free** project; `forge_owner`, `forge_app` and `forge_lookup` roles created with SQL; scale-to-zero stays on (it can't be turned off on Free); preview branches optional
- [ ] Cloudflare R2 bucket(s) `forge-media-{env}` on the free tier; CORS for presigned PUT from the app origin. No R2 custom domain: media is served by the app at `/media`
- [ ] Domain: one DNS record, `cms.forgelinetechnologies.com` CNAME → Vercel, added to the project (free on Hobby). `forgelinetechnologies.com` is otherwise untouched
- [ ] Resend Free with `cms.forgelinetechnologies.com` as the sending domain (DNS records only: SPF/DKIM/DMARC); Sentry Developer project; Cloudflare Turnstile keys; Stripe test mode
- [ ] Optional: a free external scheduler calling `GET /api/internal/cron` every minute with the cron secret (plan §16)
- [ ] Environment variables set per environment:

  | Group | Variables |
  |---|---|
  | Database | `DATABASE_URL` (pooled, `forge_app`), `DATABASE_MIGRATION_URL` (CI only) |
  | Hosts | `APP_ORIGIN` (`https://cms.forgelinetechnologies.com`; unset on previews). Post-V1: `HOST_ROUTING_ENABLED`, `SITES_ROOT_DOMAIN`, `MEDIA_PUBLIC_BASE_URL` |
  | Auth | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID/SECRET` |
  | Email | `RESEND_API_KEY`, `EMAIL_FROM` |
  | Storage | `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID/SECRET` |
  | Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO` |
  | Domains *(post-V1)* | `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` |
  | Security | `CRON_SECRET`, `PREVIEW_TOKEN_SECRET`, `TURNSTILE_SECRET_KEY`/`NEXT_PUBLIC_TURNSTILE_SITE_KEY` |
  | Observability | `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` |
  | Staff | `PLATFORM_ADMIN_EMAILS` |

**Status (2026-09-30):** *Partially done.* The repository side is complete: `vercel.json` crons, `.env.example`, and [`docs/runbooks/environments.md`](../runbooks/environments.md) with exact provisioning steps. **Every account item above is pending the owner.** This session had no credentials for Vercel, Neon, R2, Resend, Sentry, Stripe or Turnstile, no domain purchases, and no GitHub remote to connect Vercel to. Runbook discovery: create `forge_app` and `forge_owner` **with SQL, not the Neon console**. Console-, CLI- and API-created roles join `neon_superuser`.

**Likely files/modules:** `vercel.json` (crons), `.env.example`, `docs/runbooks/environments.md`

**Testing:** the deployment answers on `cms.forgelinetechnologies.com`; a seeded site answers at `/s/{address}`; `/api/health/ready` is green.

### M0-3 · Spike S2: `pg` Pool + `withTenant` + RLS through Neon's pooler
**Labels:** `area:platform` `type:spike` `risk:high`

**Description:** Prove transaction-scoped tenant context with RLS on Neon's PgBouncer endpoint via Drizzle, and measure the cost.

**Depends on:** M0-2

**Acceptance criteria:**
- [x] Prototype `withTenant(ctx, fn)` using `set_config('app.org_id', …, true)` inside a transaction; `forge_app` cannot bypass RLS
  - *Done:* implemented directly as production code (`src/platform/db/tenant.ts`) and proven by 58 integration tests through PgBouncer in transaction mode (`tests/integration/rls.test.ts`).
- [x] Demonstrates the `nullif(current_setting(...), '')` behaviour on reused pooled connections
- [ ] Latency measured on Vercel → Neon (p50/p95 for a 3-query transaction vs no transaction)
  - *Partial:* measured locally through PgBouncer: +0.74 ms at p50 (`scripts/spikes/rls-latency.ts`). The Vercel → Neon run is **pending account access** (M0-2); the command is in ADR 0001.
- [x] ADR `docs/adr/0001-rls-withtenant.md` with the decision: keep thin RLS, or use the fallback (§4.3 of the plan)
  - *Decision:* keep thin RLS. Discoveries: the token lookups need a dedicated `forge_lookup` owner role, because FORCE binds the table owner too; the function-ownership grant needs a temporary `CREATE`; Neon roles must be created with SQL.

**Likely files/modules:** `spikes/rls/*`, `docs/adr/`

**Testing:** the spike script, with results recorded in the ADR.

### M0-4 · Spike S1: host routing + Cache Components tag invalidation on Vercel
**Labels:** `area:rendering` `type:spike` `risk:high`

**Description:** Prove that `proxy.ts` rewrites by host to `/render/[host]`, and that `'use cache'` + `cacheTag` + `updateTag`/`revalidateTag` behave correctly for hosts unknown at build time.

**Depends on:** M0-2

**Status:** Proven locally on a production build. The Vercel preview run is pending the M0-2 accounts (runbook §5). *2026-10-01 (ADR 0006): V1 addresses sites by path (`/s/{address}`). The host routing proven here is kept behind `HOST_ROUTING_ENABLED` for post-V1. The spec now runs on one host, and the Vercel run targets a Hobby deployment with no `?__host=`.*

**Acceptance criteria:**
- [x] Two test hosts render different content from the same route; direct `/render/*` requests 404 — unknown hosts also return a real 404 status
- [x] Publishing via a Server Action (`updateTag`) shows fresh content on the next request; a job-style route handler (`revalidateTag` with `expire: 0`) also works — locally; other sites' cache entries survive
- [x] Admin pattern under Cache Components (a static shell + authenticated data in `<Suspense>`) documented — ADR 0002 decision 4; `/dev/cache` is the reference page
- [x] ADR `0002-host-routing-and-caching.md` with the recommended `cacheLife` profile — `cms`: stale 5 min, revalidate 1 day, expire 7 days

**Likely files/modules:** `spikes/rendering/*`, `src/proxy.ts` (prototype), `docs/adr/`

**Testing:** a Playwright script against the preview deployment. ✔ `tests/e2e/rendering-spike.spec.ts` (9 tests) passes locally. The same spec runs against a deployment with `E2E_BASE_URL` (tenant hosts via `?__host=`). ☐ Preview run pending accounts.

### M0-5 · Spike S3: Tiptap custom nodes + closed renderer + drag reorder
**Labels:** `area:editor` `type:spike` `risk:high`

**Description:** Validate the one-document editor (plan §6): custom `image`, `columns`/`column` and `button` nodes with React NodeViews, stable IDs, top-level drag reorder, and a server-side node → React renderer.

**Depends on:** M0-1

**Acceptance criteria:**
- [x] Columns (2–3) with blocks inside; nested columns prevented by the schema — in the editor schema, the Zod contract and the renderer
- [x] Top-level blocks reorder by drag handle and Alt+↑/↓; undo works across reorder — headless tests and real Chromium (Tiptap's drag handle)
- [x] Every top-level node gets a stable `id` attribute that survives copy/paste (duplicates re-IDed) — UUIDv7 via UniqueID. Cut/paste gives moved blocks new ids (ADR 0003, gap 3)
- [x] The server renderer outputs only allow-listed elements; pasted `<script>`/`onerror` HTML is dropped — 31-payload corpus, plus a paste guard for custom-node attributes
- [x] ADR `0003-editor.md`: chosen extensions (open-source only), known gaps, estimate for Phase 5

**Likely files/modules:** `spikes/editor/*`

**Testing:** a Vitest renderer test with an XSS payload list; manual editor script. ✔ `spikes/editor/*.test.ts(x)` (75 unit), `save-draft.integration.test.ts` (5), `tests/e2e/editor-spike.spec.ts` (6, real Chromium). The manual page is `/dev/editor` (never served on Vercel production). Also covers document JSON, validation, autosave and version conflicts.

### M0-6 · Spike S4: Better Auth on our schema with UUIDv7
**Labels:** `area:auth` `type:spike`

**Description:** Confirm Better Auth works with the Drizzle adapter, our table and column names (`users`, `auth_accounts`, `auth_sessions`, `auth_verifications`), UUIDv7 IDs and DB sessions, with `cookieCache` disabled.

**Depends on:** M0-1

**Acceptance criteria:**
- [x] Sign-up/login/logout against local Postgres using mapped tables — through PgBouncer as `forge_app`; better-auth 1.7.6 pinned
- [x] ID generation produces UUIDv7 (or the ADR documents the fallback) — native, via `advanced.database.generateId`; no fallback needed
- [x] Session revocation takes effect on the next request
- [x] ADR `0004-auth.md` — also records the `identityDb()` seam, the 30-day absolute-lifetime hook, and notes for M2-1 and M2-4

**Likely files/modules:** `spikes/auth/*`

**Testing:** integration test in the spike. ✔ `spikes/auth/auth.integration.test.ts` (16 tests), which also covers password hashing, the verification flow, cookie attributes and Google OAuth readiness

---

## M1 — Platform foundation

### M1-1 · Database layer: pool, `withTenant`, helpers, migrations, roles, RLS template
**Labels:** `area:platform` `type:infra` `risk:high`

**Description:** Implement `platform/db` from the S2 decision: the single entry point for all database work.

**Depends on:** M0-3

**Acceptance criteria:**
- [x] `getDb()` (lazy) with a `pg` Pool + `attachDatabasePool`; `withRetry` for transient errors on idempotent reads
- [x] `withTenant({ orgId, userId? }, fn)` opens a transaction, sets the context, and passes a typed `tx`; `withSystem(fn)` only for platform tables
  - *Named:* `withPlatform(fn)` (platform/identity tables) plus `withUser(userId, fn)` for membership lookups before an org is chosen (plan §4.3 membership class).
- [x] Column helpers: `id()` (UUIDv7), `timestamps()`, `softDelete()`, `status(values)` (text + CHECK), `tenantColumns()`
  - *Named:* `textEnum()` + `oneOf()` for status columns; `orgColumns()` / `siteColumns()` for tenant columns.
- [x] `tenantTable()` adds the tenant columns, the composite FK to `sites`, `UNIQUE (site_id, id)`, and the RLS policy, and registers the table in the isolation-suite registry
  - *Changed shape:* a single generic `tenantTable()` wrapper fights Drizzle's `pgTable` typing. Tables use plain `pgTable` with small helpers instead (`siteColumns()`, `siteForeignKey()`, `tenantPolicy()`). The registry is `src/platform/db/table-classes.ts`, and the isolation suite **diffs it against the live catalog**, so an unregistered or unprotected table fails CI. That's stronger than opt-in registration.
- [x] Migration pipeline: `db:generate`, `db:migrate` (owner URL), custom SQL migration for roles/grants/`FORCE RLS`/`pg_trgm`; `db:push` blocked unless `DATABASE_URL` is local
  - *Note:* roles themselves are environment setup (`docker/postgres/init.sql`, runbook), not migrations. Migrations grant to them.
- [x] Migration review checklist added to the PR template

**Also delivered here (per the implementation brief):** the full 24-table V1 schema (`drizzle/0001_v1_schema.sql`, `0002_rls_force_grants_lookups.sql`). The schema-level criteria of M3-1, M4-1, M5-1, M6-1, M8-3, M8-5, M10-1 and M11-1 are therefore met in advance. Their services, UI and behaviour stay in their milestones.

**Likely files/modules:** `src/platform/db/*`, `drizzle.config.ts`, `drizzle/0000_*.sql`, `.github/pull_request_template.md`

**Testing:**
- integration: context set/cleared per transaction
- a table under RLS returns 0 rows without context and the right rows with it
- an insert with the wrong `organization_id` fails `WITH CHECK`

### M1-2 · Config, error model, logging, request IDs, Sentry
**Labels:** `area:platform` `type:infra`

**Description:** The cross-cutting runtime basics.

**Depends on:** M0-1

**Status:** Done locally. The Sentry check from a preview is pending the Sentry project and Vercel deployment (M0-2).

**Acceptance criteria:**
- [x] `platform/config/env.ts`: Zod-validated, read lazily; importing a module never throws on a missing variable — variables are grouped by feature. `REQUIRED_ENV_GROUPS` is `core` + `database` today; each issue adds its group when shipped code starts reading it. The DB pool reads `env("database")`
- [x] `AppError` kinds (`NotFound`, `Forbidden`, `Validation`, `Conflict`, `LimitExceeded`, `RateLimited`, `Unavailable`) + mappers to `ActionResult` and `problem+json` — problem `type` is `urn:forge:problem:<kind>`; LimitExceeded → 402, Validation → 422 with `errors[]`; unexpected errors → a generic 500 / "Reference: {requestId}"
- [x] JSON logger with `requestId`, `orgId`, `siteId`, `actor`, `module`; request ID from the proxy header, available via AsyncLocalStorage for logging only — redacts secrets and emails; drops driver `detail`. `assignRequestId()` is ready for the proxy (M1-7): it reuses `x-vercel-id`, otherwise mints a UUIDv7, and ignores client-supplied ids
- [x] Sentry server + client with release = commit SHA, tenant IDs as tags, PII scrubbing — `@sentry/nextjs` 11.1.0 (`dataCollection` off + `beforeSend` scrub). The client SDK loads lazily on the admin surface only, so public sites ship no Sentry JS. Source maps upload only when `SENTRY_AUTH_TOKEN` is set
- [x] `/api/health` (liveness) and `/api/health/ready` (DB ping + env groups) — per-group `ok`/`missing`/`invalid`, no variable names; 503 when not ready

**Likely files/modules:** `src/platform/config/*`, `src/platform/observability/*`, `src/platform/errors.ts`, `src/app/api/health/*`

**Testing:** unit tests for error mapping and env parsing; a test error visible in Sentry from preview. ✔ Unit: env, errors, logger, scrub, request id, readiness, bearer. Integration: DB ping through PgBouncer. E2E: readiness, sentry-test 404. ☐ Sentry from preview: `POST /api/internal/sentry-test` with the cron secret (runbook §4), pending accounts.

### M1-3 · Job queue: table, enqueue, runner, cron routes
**Labels:** `area:platform` `type:infra`

**Description:** The Postgres job queue (plan §16).

**Depends on:** M1-1

**Acceptance criteria:**
- [x] `jobs` table (platform class) with `dedupe_key` partial unique index — from M1-1; migration 0003 adds a partial index for the reaper
- [x] `jobs.enqueue(tx, type, payload, { runAt?, dedupeKey?, maxAttempts? })` inside the caller's transaction; payloads validated by per-type Zod schemas in a registry — `type` is passed as its `defineJob()` definition (typed payload). Tenant jobs take the organization from the transaction's RLS context. The runner's registry is composed in `src/app/api/internal/cron/jobs.ts` (ADR 0005)
- [x] Runner: claims with `FOR UPDATE SKIP LOCKED`; exponential backoff with jitter; `dead` after max attempts; reaper for expired locks; stops at ~75% of the time budget — plus fencing on `attempts`, `failed` for permanent errors, and a 900 s default claim
- [x] `/api/internal/cron` (every minute) and `/api/internal/cron/daily` (03:00) authenticated with `CRON_SECRET`; configured in `vercel.json` — 404 without the secret. *2026-10-01 (ADR 0006): Vercel Hobby only allows daily crons, so `vercel.json` schedules only `/daily`, which now also runs the runner. The minute endpoint is for an optional external scheduler or a paid plan*. The daily route enqueues `jobs.cleanup` (retention, long-term §6.9)
- [x] `kickJobs()` helper using `after()` — runs only the kicked job types, best effort

**Likely files/modules:** `src/platform/jobs/*`, `src/app/api/internal/cron/*`, `vercel.json`

**Testing:** integration with a fake clock: success, retry with backoff, dead-letter, concurrent runners never double-claim, dedupe. ✔ `tests/integration/jobs.test.ts` (24 tests through PgBouncer, mutation-checked), `src/platform/jobs/definition.test.ts` (4), `tests/e2e/cron.spec.ts` (4).

### M1-4 · Email: provider interface, Resend adapter, templates, `email.send` job
**Labels:** `area:platform` `type:infra`

**Description:** Replaceable transactional email, always sent through jobs.

**Depends on:** M1-3

**Acceptance criteria:**
- [x] `EmailProvider` interface; Resend adapter using the idempotency key = job ID; console/Mailpit adapter for dev; capture adapter for tests — Resend over its HTTP API (no SDK). Mailpit via its HTTP API (local inbox). Console logs subject only. Messages have no `from`: the sender is `EMAIL_FROM` (ADR 0007)
- [x] React Email base layout + templates: verify email, reset password, invitation, trial ending, payment failed — typed props, escaped, no logic
- [x] `email.send` job; failures are retried and never throw into the caller; configuration faults are logged with an explanation
  - Recipients are resolved from records (user, invitation under RLS, owners); links must be on `APP_ORIGIN`.
  - New queue scope `inherit`; one-time links are redacted from the payload once finished.
  - Better Auth's verify and reset hooks queue it (`sendEmailSoon`).

**Likely files/modules:** `src/platform/email/*`

**Testing:** unit tests for template rendering; integration: an enqueued email is delivered to the capture adapter exactly once despite a retry. ✔
- `providers.test.ts` and `templates.test.tsx` (24).
- `tests/integration/email.test.ts` (15): exactly-once despite a retry, retries, permanent and configuration failures, tenant isolation, redaction, Better Auth sign-up and reset.
- `tests/e2e/email.spec.ts` (2): via Mailpit.

### M1-5 · Storage driver: interface + S3-compatible adapter
**Labels:** `area:platform` `type:infra`

**Description:** `StorageDriver` (plan §8) with a local filesystem driver for development and tests, and the S3 implementation used for R2 in production (RustFS in the integration tests). See ADR 0008.

*V1 (ADR 0006): `publicUrl(key)` = `MEDIA_PUBLIC_BASE_URL` + key, defaulting to `${APP_ORIGIN}/media` (`mediaPublicBaseUrl()` in `platform/config/env.ts`). Storage keys never depend on the public URL.*

**Depends on:** M0-2

**Acceptance criteria:**
- [x] Interface: `createUpload` (presigned PUT signing content-type and content-length), `head`, `readRange`, `get`, `put`, `delete`, `publicUrl`
  - `put` never overwrites (`AlreadyExists`).
  - One `StorageError` with eight codes, mapped to the app error model.
  - Tenant scope via `storageFor({ organizationId, siteId? })`, with `platformStorage()` for platform work. The raw driver is private to `platform/`.
- [x] S3 adapter configured by env (endpoint, region `auto`, bucket)
  - Variables: `STORAGE_ENDPOINT`, `STORAGE_REGION` (default `auto`), `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`.
  - `STORAGE_DRIVER` selects the driver: `s3` by default on Vercel, `local` elsewhere.
  - Lazy; missing settings are a `ConfigurationError` on use and show in readiness.
  - The AWS SDK is imported only in `platform/storage/providers` (lint).
- [x] Key builder `o/{org}/s/{site}/m/{media}/v{n}/{variant}/{name}.{ext}` — `mediaObjectKey()`. Every key is validated on every call, so traversal is unrepresentable
- [x] *Added:* local filesystem driver (`.storage/`, gitignored). Its upload target is the signed app route `/api/storage/local/{key}`, so development and tests need no storage account

**Likely files/modules:** `src/platform/storage/*`

**Testing:** integration against RustFS: presigned PUT round trip, a content-length mismatch is rejected, HEAD/readRange/delete. ✔
- `tests/integration/storage.test.ts` (45): the same contract against the local and the S3 driver, including upload round trips and rejections, tenant isolation, provider-failure mapping and configuration.
- `src/platform/storage/storage.test.ts` (34).
- `tests/e2e/storage.spec.ts` (3).

The suite can run against real R2 with `TEST_S3_*`.

### M1-6 · Test harness + isolation-suite framework
**Labels:** `area:platform` `type:test` `risk:high`

**Description:** Make tenant isolation testable from the first tenant table onward.

**Depends on:** M1-1

**Status:** ✔ done. The last helper (the "B's IDs → 404" registry) was delivered with M3-1.

**Acceptance criteria:**
- [x] Integration DB per Vitest worker (template database clone), migrations applied once — `tests/setup/integration-global.ts` migrates `forge_test_template` once, then clones `forge_test_w1..4`
- [x] Factories: user, org (+ membership), site, entry, media, term — `tests/fixtures/factories.ts`; the term is created by `createPublishedEntry`, and `createTenantGraph` fills every tenant table
- [x] Isolation suite (`tests/integration/isolation.test.ts`):
  - reads the table-class registry (`src/platform/db/table-classes.ts`, which replaced `tenantTable()`, see M1-1) and diffs it against the live catalog (`tests/isolation/coverage.ts`)
  - asserts RLS enabled + forced for each table
  - seeds orgs A and B
  - runs registered read functions (`tests/isolation/tenant-reads.ts`) under A's context and asserts no B rows. It starts with one no-WHERE read per tenant table; repository reads are added there as they land.
- [x] Helper to register actions and route handlers for "B's IDs → 404" checks — delivered with M3-1: `tests/isolation/tenant-operations.ts`. Each registered operation runs as a member of A with B's identifiers and must answer `NotFound` while a digest of B's rows stays unchanged. It holds the tenancy services today; **register every new service, action and route handler that accepts an id or a slug there**
- [x] Captured-email helper for E2E (reads the capture adapter or Mailpit) — delivered with M1-4: `tests/e2e/helpers/mailbox.ts` (Mailpit), and `CaptureEmailProvider` for integration tests

**Likely files/modules:** `tests/setup/*`, `tests/isolation/*`, `tests/fixtures/*`

**Testing:** the suite fails if a table is created without RLS (a fixture proves it). ✔ `detects an unprotected tenant table` creates a table with `organization_id` and no RLS as the owner and asserts the audit reports it.

### M1-7 · `proxy.ts` host routing, guards and cache primitives
**Labels:** `area:rendering` `type:infra`

**Description:** Classify hosts and route requests.

*2026-10-01 (ADR 0006), done in the same change:*
- *Path mode is always on: `/s/{address}/…` → `/render/address~{address}/…`, on any host. Host mode (`HOST_ROUTING_ENABLED`, post-V1) maps platform subdomains and custom domains to the same renderer.*
- *`Next-Action` is rejected on site pages in both modes.*
- *The proxy sets framing headers per surface: admin `frame-ancestors 'none'`, sites `'self'`.*
- *`?__host=` applies to host mode only.*
- *`hosts.test.ts` now has 56 cases.*

**Depends on:** M0-4, M1-2

**Status:** Done, except the admin cookie-presence redirect, which needs the login page (M2-2).

**Acceptance criteria:**
- [x] Host normalisation (lowercase, strip port and trailing dot) — plus IDN → punycode; malformed hosts → 404
- [x] Routing: app host → admin/API; anything else → rewrite to `/render/{host}{path}` — decisions in the pure `decideRoute()` (`src/platform/routing/hosts.ts`); `APP_ORIGIN` missing → only `/api/health*` answers (503 otherwise)
- [x] `x-request-id` assigned — on the forwarded request and the response
- [ ] Guards:
  - [x] direct `/render/*` → 404 on every host
  - [x] `Next-Action` requests on non-app hosts → 404
  - [ ] the admin cookie-presence redirect is UX only — **deferred to M2-2**, when the login page and session cookie exist
- [x] Non-production host override (`?__host=`) for preview deployments — ignored when `VERCEL_ENV=production`
- [x] `platform/cache`: tag builders (`host`, `site`, `config`, `routes`, `entry`, `list`, `media`), `invalidate(events, mode)` using `updateTag` (actions) or `revalidateTag` (handlers/jobs), and the `cms` `cacheLife` profile — with the pure `tagsFor(event)` map; over-long `host:` tags are shortened to fit Next's 256-character limit

**Likely files/modules:** `src/proxy.ts`, `src/platform/cache/*`

**Testing:** a unit table of host → route decisions; E2E: a site host can't reach admin routes or actions. ✔ `hosts.test.ts` (30 cases), `cache.test.ts` (10), `rendering-spike.spec.ts` (guards, request id, override).

---

## M2 — Authentication

### M2-1 · Better Auth integration and session helpers
**Labels:** `area:auth` `type:feature`

**Status:** ✔ done (2026-10-03). See the M2-1 addendum in ADR 0004.

**Description:** Production Better Auth setup per ADR 0004.

*From M0-6: the tables and migration were delivered in M1-1. Start from `spikes/auth/auth.ts` and use `identityDb()` for the adapter. Mind the Cache Components note in ADR 0004 (discovery 9).*

*From M1-4: wire Better Auth's `sendVerificationEmail` and `sendResetPassword` hooks to `sendEmailSoon({ template, userId, url })` from `@/platform/email`, exactly as `tests/integration/email.test.ts` does. Delete the `/api/dev/email` dev route once real sign-up exists.*

**Depends on:** M0-6, M1-1, M1-4

**Acceptance criteria:**
- [x] Tables `users`, `auth_accounts`, `auth_sessions`, `auth_verifications` via reviewed migration (delivered in M1-1; M2-1 needed no migration)
- [x] Handler at `/api/auth/[...all]`; `trustedOrigins` = app origin; cookie host-only, secure, `SameSite=Lax`; 7-day sliding / 30-day absolute; `cookieCache` off
- [x] Auth emails routed through `email.send` jobs with an `after()` kick
- [x] `modules/auth` exports `getCurrentUser()` (React `cache`), `requireUser()` and `requireVerifiedUser()`; lint forbids Better Auth imports elsewhere

**Delivered beyond the criteria (clarifications, no scope change):**
- `Unauthenticated` (401) added to the error model; `authErrorToAppError()` for the UI.
- The proxy strips `Cookie` and `Authorization` from `/s/…` requests (one origin, ADR 0006).
- Origin/CSRF checks pinned on; reset tokens and OAuth state stored hashed; unused Better Auth endpoints disabled.
- `BETTER_AUTH_SECRET` optional on localhost only; Google credentials optional.
- The spike (`spikes/auth`) and the `/api/dev/email` route are removed.

**Likely files/modules:** `src/modules/auth/*`, `src/app/api/auth/[...all]/route.ts`

**Testing:** integration: session create/resolve/revoke; an unverified user is rejected by `requireVerifiedUser`. ✔ `tests/integration/auth.test.ts` (33), `src/modules/auth/*.test.ts` (42), `tests/e2e/auth.spec.ts` (5).

### M2-2 · Sign-up, login, logout, email verification UI
**Labels:** `area:auth` `type:feature`

**Status:** ✔ done (2026-10-04). See the M2-2 addendum in ADR 0004.

**Description:** The account screens.

*From M1-7: add the admin cookie-presence redirect to `proxy.ts` (UX only; the real check stays in `requireUser()`).*

*From M2-1: the back-end is live at `/api/auth/*`. Map failures with `authErrorToAppError()` and never show Better Auth's text. Read the session inside `<Suspense>` in pages and layouts. `/api/app/session` returns the signed-in user. The E2E helpers in `tests/e2e/helpers/auth.ts` drive the API; switch them to the forms here.*

**Depends on:** M2-1

**Acceptance criteria:**
- [x] `/signup` (email, password ≥ 12, Turnstile), `/login`, logout in the account menu, `/verify-email` with resend (throttled)
- [x] Generic login error; `?next=` restricted to same-origin paths
- [x] Verified-email banner in the admin until verified
- [x] *Moved here from M2-3 at the owner's direction:* `/forgot-password` → always the same response; `/reset-password` with a single-use 60-minute token; all sessions revoked on reset

**Delivered beyond the criteria (clarifications, no scope change):**
- The forms reach Better Auth through its request handler, so its rate limiter, origin checks and captcha apply to them.
- Signing in or out ends with a full page load, so nothing of the previous session stays in the tab.
- The proxy renews the browser cookie on admin page loads (Server Components cannot set cookies).
- Turnstile is optional outside Vercel production and required there (`turnstile` is now a readiness group).
- `/` is the first protected page (header, account menu, banner) until M3 turns it into the organization redirect.

**Likely files/modules:** `src/app/(admin)/(auth)/*`, `src/modules/auth/ui/*`

**Testing:** E2E: sign up → verify via the captured email → log out → log in. ✔ `tests/e2e/auth.spec.ts` (14), `tests/integration/auth-flows.test.ts` (32), unit tests under `src/modules/auth` and `src/platform/routing`.

### M2-3 · Password reset and Google OAuth
**Labels:** `area:auth` `type:feature`

**Status:** ✔ done (2026-10-04). See the M2-3 addendum in ADR 0004.

**Description:** Recovery flow and social login.

*From M2-1: the reset back-end is live and tested: a 60-minute single-use token (stored hashed), every session revoked on reset, the same response for unknown addresses. The emailed link redirects to `/reset-password?token=…`. This issue adds the pages, the notification email and the linking-rule test.*

*From M2-2: the reset pages and their E2E flow are delivered (see M2-2). What remains here is the "your password was changed" notification email and Google sign-in. The Google button belongs on `LoginForm` and `SignUpForm`, shown only when `GOOGLE_CLIENT_ID` is configured; start the flow through `callAuth("/sign-in/social", …)` so the origin and redirect checks apply, and pass `callbackURL` through `safeNextPath()`.*

**Depends on:** M2-1

**Acceptance criteria:**
- [x] `/forgot-password` → always the same response; `/reset-password` with a single-use 60-minute token; all sessions revoked on reset *(delivered in M2-2)*
- [x] Notification email after a password reset (also sent after `/change-password`)
- [x] Google OAuth sign-in and sign-up; auto-link **only** when Google asserts a verified email equal to the account's verified email

**Delivered beyond the criteria (clarifications, no scope change):**
- The button appears only when both Google credentials are set; nothing else depends on them.
- Google's tokens are not stored (a stored ID token could be replayed to `/sign-in/social`).
- OAuth failures land on `/login?error=<code>` with Forge's own wording.
- `agentRules: false` in `next.config.ts`: `next dev` no longer writes `AGENTS.md` / `CLAUDE.md`.

**Not covered:** a browser round trip through real Google (needs a real account and client secret). Check it by hand on the first deployment with credentials.

**Likely files/modules:** `src/modules/auth/*`, auth pages

**Testing:** E2E reset flow ✔ (M2-2); integration test of the linking rule with a mocked provider response. ✔ `tests/integration/auth-google.test.ts` (39; only Google's token endpoint is replaced), `tests/e2e/google.spec.ts` (5).

### M2-4 · Account page, sessions and auth hardening
**Labels:** `area:auth` `type:feature`

**Description:** Self-service account management plus abuse controls.

*From M0-6: Better Auth's limiter uses in-memory storage by default, which is per instance on Vercel. The WAF rule is the real control (ADR 0004, discovery 8).*

*From M2-1: the limiter is already on in production with its defaults, keyed by `x-forwarded-for`. Sign-up reveals that an address is registered (ADR 0004 addendum), so the sign-up limit and Turnstile are what bound enumeration.*

*From M2-3: `/change-password` already queues the "password changed" notice (an `after` hook in `createAuth`); the account page only needs the form. Google identities cannot be linked or unlinked by the user in V1 (`/link-social` and `/unlink-account` are disabled): if the account page lists sign-in methods, it is read-only. An account created through Google has no password; "change password" needs a current one, so offer "set a password" through the reset email instead.*

*From M2-2: the forms are Server Actions, which post to the page's own path, not to `/api/auth/*`. The WAF rule must also cover `POST` to `/login`, `/signup`, `/forgot-password`, `/reset-password` and `/verify-email`. Better Auth's limiter already covers the forms (they go through its handler). Turnstile on sign-up is delivered. The account menu (`AccountMenu`) is where the `/account` link goes.*

**Depends on:** M2-2, M1-5

**Status:** ✔ done (2026-10-05), except the two items marked below. See the M2-4 addendum in ADR 0004.

**Acceptance criteria:**
- [x] `/account`: name, change password (revokes other sessions), list and revoke sessions
- [ ] `/account`: avatar (upload via the storage driver) → **moved to M6-2.** An avatar has to be served from `/media/{key}`, which is M6's route, with M6's type checks. Nothing in M2-4 can show an uploaded image safely before that
- [x] Better Auth limiter enabled (stated in the configuration, not left to the library default), and it covers the account actions
- [ ] Vercel WAF rate-limit rule → **owner, at deployment.** It is created in the Vercel project, not in the repository; the exact rule is in runbook §2a and now also covers `POST /account`
- [x] Audit rows for login, logout, password change (org-less entries)

**Delivered beyond the criteria (clarifications, no scope change):**
- Sessions are shown and ended by an opaque handle; no session id or token reaches the browser (`/api/app/session` no longer returns the id).
- `/update-user` accepts the name only. It would otherwise accept any picture URL.
- An account created with Google gets "email me a link" in place of the change-password form.
- A minimal audit writer for platform events (`recordPlatformEvent`); `audit.record(tx, …)` is still M3-5.

**Likely files/modules:** `src/app/(admin)/account/*`, `src/modules/auth/actions.ts`

**Testing:** E2E revoke session in browser A → browser B is logged out on the next request. ✔ `tests/e2e/account.spec.ts` (6, several browser contexts and a second user), `tests/integration/auth-account.test.ts` (26), `tests/integration/auth-audit-failure.test.ts`.

---

## M3 — Organizations & RBAC

### M3-1 · Tenancy schema and RLS policies
**Labels:** `area:tenancy` `type:feature` `risk:high`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services and tests.*

**Status:** ✔ done (2026-10-05). See the M3-1 addendum in ADR 0001.

**Description:** The multi-tenant core tables, and the tenancy module around them.

**Depends on:** M1-1, M1-6, M2-1

**Acceptance criteria:**
- [x] Tables: `organizations`, `organization_members`, `organization_invitations`, `roles` (5 system rows seeded), `subscriptions` (plan/trial columns)
- [x] Standard RLS; membership policies visible via `app.user_id`; `resolve_invitation(token_hash)` `SECURITY DEFINER` returning minimum columns
- [x] Reserved org slugs enforced (`modules/tenancy/slugs.ts`; a unit test fails when a top-level route is not reserved)

**Delivered at the owner's direction (the backend of later issues; their screens remain where they were):**
- The tenant resolver: `resolveOrgContext`, `resolveSiteContext`, and `requireOrgContext` / `requireSiteContext` for the current request (listed under M3-2).
- Organization services: `createOrganization` (organization + Owner membership + trial, one transaction), `listOrganizations`, `updateOrganization` (listed under M3-3).
- Member services: `listMembers`, `changeMemberRole`, `removeMember`, `leaveOrganization`, `transferOwnership`, with the last-Owner rule under a row lock (listed under M3-3 and M3-4).
- `canAccessSite`, and the read side of the sites module (`findSiteBySlug`, `siteAddress`).
- Migration 0004: `organizations` and `organization_members` stay readable by their members, and become writable only inside the tenant context.

**Likely files/modules:** `src/modules/tenancy/*`, `drizzle/*`

**Testing:** isolation suite covers these tables; a user sees only their own orgs in the switcher query. ✔ `tests/integration/tenancy.test.ts` (51), `tests/integration/isolation.test.ts` (34, including the cross-tenant operations registry), `tests/e2e/tenancy.spec.ts` (2).

### M3-2 · Permission catalog, policies, context resolvers
**Labels:** `area:tenancy` `type:feature` `risk:high`

**Status:** ✔ done (2026-10-05). See ADR 0009.

**Description:** Authorization for everything that follows.

*From M3-1: the context resolvers exist (`modules/tenancy/context.ts`): they answer "which organization and site, and is the user a member". What remains here is "what may they do": the catalog, `can()`, and `policies.ts`. Add `permissions` to the context where it is built (`resolveOrgContext`), not beside it. The four membership rules in `membership-rules.ts` include `canManageMembers` / `canManageOrganization`: express those two through the catalog (`org.members.manage`, `org.manage`) and keep the invariants (last Owner, only an Owner grants Owner) where they are. Contexts are sealed: build one only through the resolver, including in tests.*

**Depends on:** M3-1

**Acceptance criteria:**
- [x] `permissions.ts` catalog (plan §13), with role → permission sets in code and `entries.{type}.{action}` keys *(29 keys; the one wildcard is `entries.*.{action}`, in the type segment only)*
- [x] `can(ctx, permission, resource?)` with `.own` ownership rules; unknown roles hold nothing *(and `requirePermission()`, which throws `Forbidden`; `can()` never throws)*
- [x] `requireOrgContext(orgSlug)` and `requireSiteContext(orgSlug, siteSlug)` (React `cache`) → context; 404 for non-members *(delivered in M3-1; this issue added `ctx.permissions`)*
- [x] `policies.ts` helpers used by later modules *(`can`, `requirePermission`, `canActOn` for own/any pairs, and the tenancy policies `canUpdateOrganization`, `canTransferOwnership`, `canManageMembers`)*

**Also delivered:**
- The M3-1 services now ask the catalog: a policy check on the request's context first, then the same permission on the role re-read under the organization lock, then the membership rules. `canManageMembers(role)` / `canManageOrganization(role)` are gone.
- A member without the permission is refused before their input is read (`Forbidden` whatever id they name; before M3-2 a malformed or foreign id answered `NotFound` and a bad role `Validation` first). Members with the permission see no change.
- A `roles` row that is not one of the five system rows gives its members nothing, whatever its key (the repository joins system roles only).
- ESLint: outside `modules/tenancy`, comparing a role with a role name fails lint and points at `can()`.
- The isolation suite runs every registered operation a second time as a Viewer, and has a registry for policies that take a resource (`tenantPolicyChecks`).
- A race in an M2-2 browser test, found here: "the keyboard alone is enough to log in" pressed Enter before the account menu had moved focus (Radix moves it on a 0 ms timer), so on a fast machine it opened Account instead of logging out. It failed on the M3-1 commit as well. The test now waits to see focus land, which also asserts where focus is.

**Not here, by design:** no read permissions for the organization, its members or its sites (membership grants them); no entry or media policies yet (their modules add them on `canActOn`); no screens.

**Likely files/modules:** `src/modules/tenancy/{permissions,policies,context}.ts`

**Testing:**
- generated matrix test (catalog × roles)
- wildcard and unknown-role cases
- context returns 404 for a non-member

✔ `src/modules/tenancy/permissions.test.ts` (173: the matrix is 145 of them, plus the ADR's table against the code), `src/modules/tenancy/policies.test.ts` (28), `tests/integration/permissions.test.ts` (30, real Postgres), `tests/integration/isolation.test.ts` (46, +12), `tests/unit/lint-boundaries.test.ts` (+7), `tests/e2e/tenancy.spec.ts` (+1).

### M3-3 · Onboarding (organization), org switcher, org settings, ownership transfer
**Labels:** `area:tenancy` `type:feature`

**Status:** ✔ done (2026-10-05). See the M3-3 addenda in ADR 0001 and ADR 0009.

**Description:** Create and manage organizations.

*From M2-2: `/` is currently a placeholder protected page (`src/app/(admin)/page.tsx`): header with `AccountMenu`, the `VerifyEmailBanner`, and `requireUserOrLogin("/")` inside `<Suspense>`. Replace its body with the redirect, and reuse the header in the admin shell. Protected layouts call `requireUserOrLogin(path)`; the proxy's login redirect is only a convenience. After sign-up the user lands on `/verify-email` and continues to `/`.*

*From M3-1: the services exist. `createOrganization(actor, { name, slug })` creates the organization, the Owner membership and the 14-day trial in one transaction; `suggestOrgSlug(name)` and `checkOrgSlug(slug)` (client-safe, `modules/tenancy/shared`) are for the form; `listOrganizations(actor)` is the switcher's query; `updateOrganization(ctx, …)` and `transferOwnership(ctx, { memberId })` are for the settings page. This issue is the screens, their Server Actions, and the `/` redirect. Layouts call `requireOrgContext(params.orgSlug)` and map `NotFound` to `notFound()`, `Unauthenticated` to the login redirect, and `Forbidden` (a suspended organization) to a page that says so. Register each action in `tests/isolation/tenant-operations.ts`.*

*From M3-2 (ADR 0009): decide what a screen shows with the tenancy policies on the request's context (`canUpdateOrganization(ctx)`, `canTransferOwnership(ctx)`, or `can(ctx, permission)`), in Server Components; pass booleans to Client Components, never the role. The services check again whatever the screen showed. `updateOrganization` and `transferOwnership` already start with `requirePermission(ctx, "org.manage")`. Add browser tests here for what each role sees and for the 403 and 404 pages: M3-2 had no organization routes to drive. Register the new Server Actions in `tests/isolation/tenant-operations.ts`.*

**Depends on:** M3-2

**Acceptance criteria:**
- [x] `/onboarding` step 1 creates the org, the Owner membership and a trial subscription (14 days) *(the form calls `createOrganization`, the one transaction from M3-1; a user who already has an organization is sent to it)*
- [x] `/` redirects to the last org's sites, or `/onboarding` *(a route handler: a real 307. "Last" is the organization the user joined most recently, worked out from their memberships on every request; nothing is stored. The destination is `/{org}` until `/{org}/sites` exists, M4-1)*
- [x] Org switcher in the admin shell (URL-based, D-08) *(a menu of links to `/{org}`; also on `/account`)*
- [x] `/{org}/settings`: rename, change slug, transfer ownership (Owner only) *(the 30-day redirect from the old slug is the optional part and was not built: the old URL is a 404 at once)*

**Decisions taken here (the pasted issue text and the plan left them open; all are in the ADR addenda):**
- **Who may open `/{org}/settings`: Owner and Admin.** Plan §19 says "Owner", plan §13 says "only Owner/Admin see settings", and the owner's instruction for this issue was not to make the whole page Owner-only. An Admin sees the name and URL read-only; every form is Owner-only (`org.manage`). Editors, Authors and Viewers get a "no access" page. The entry check is `canViewOrganizationSettings(ctx)` = holds `org.manage` or `org.members.manage`: no key was added to the catalog.
- **Transfer needs a typed confirmation** (the organization's slug), checked by the server as well as the dialog. No re-authentication: the architecture has none.
- **`/onboarding` is the first run only.** The screen sends a user who already has an organization to it. The service still allows a user to own several (M3-1), but no screen offers a second one yet: see the note on M11-1.
- **404 and "no access" pages under `/{org}` are sent with HTTP 200 to a signed-in visitor.** With Cache Components the admin shell starts streaming before the membership is known, so the status is already sent (Next.js behaviour; the page carries `noindex`). The content is identical for "not yours" and "does not exist". Signed-out visitors get a real redirect to the login page from the proxy, as before.

**Also delivered:**
- The admin's form kit (`Field`, `FormAlert`, `SubmitButton`, the form hook) moved from `modules/auth/ui` to `components/admin/form.tsx`, with `FormState` in `platform/forms.ts` and the failure mapping in `platform/form-failure.ts`. The auth module re-exports them, so its files did not change.
- Each form's logic lives in `modules/tenancy/organization-forms.ts` (`submit…`), apart from the `"use server"` file, so the whole path runs against real Postgres in tests and is registered in the isolation suite. The actions add only `revalidatePath`, `refresh()` and `redirect()`.
- `requireOrgPage(orgSlug)`: what every page and layout under `/{org}` starts with (login redirect, 404, or "suspended"). A unit test fails when a page under `[orgSlug]` does not call it, and when anything per-user is cached.
- A fix in `modules/auth`: in a route handler Better Auth deletes the cookie of a dead session, so `requireAuthOrLogin` now reads the cookie before resolving the session. Without it `/` lost the "your session has ended" notice.

**Likely files/modules:** `src/app/(admin)/onboarding/*`, `src/app/(admin)/[orgSlug]/*`, `src/modules/tenancy/*`

**Testing:** E2E sign up → onboarding → org created; two orgs open in two tabs work independently.

✔ `tests/e2e/organizations.spec.ts` (9: the new-user flow, the switcher with two tabs, settings per role, rename and URL change, a member demoted or removed behind an open page, ownership transfer between two browsers, cross-tenant 404, a suspended organization, a phone), `tests/integration/organization-forms.test.ts` (26, real Postgres), `tests/integration/isolation.test.ts` (60, +14), `src/modules/tenancy/home.test.ts` (10), `src/modules/tenancy/ui/ui.test.tsx` (13), `src/modules/tenancy/policies.test.ts` (29, +1), `tests/unit/organization-pages.test.ts` (40).

### M3-4 · Invitations and member management
**Labels:** `area:tenancy` `type:feature`

**Description:** Invite users and manage roles.

*From M3-1: `listMembers`, `changeMemberRole`, `removeMember` and `leaveOrganization` exist with the last-Owner rule under a row lock, and are tested under concurrency. This issue adds invitations and the screens. `acceptInvitation` must insert the membership inside the invited organization's tenant context (`withTenant` with the organization id that `resolve_invitation()` returned): since migration 0004 a membership cannot be written from a user-only context. A member is named by membership id, never by user id.*

*From M3-2 (ADR 0009): inviting takes `org.members.manage` (`requirePermission(ctx, "org.members.manage")` first, then the plan limit, then validation). The two rules that are not permissions apply to invitations too: only an Owner may invite someone as an Owner. The members screen uses `canManageMembers(ctx)` to decide what to show; the role select must not offer Owner to an Admin, and the service refuses it regardless.*

*From M3-3: the organization shell exists (`src/app/(admin)/[orgSlug]/layout.tsx`). Add "Members" to its links (every member may read the list; managing takes `canManageMembers(ctx)`), and start the page with `requireOrgPage(orgSlug, …)`: a unit test fails for a page under `[orgSlug]` that does not. Follow the forms' shape: logic in a `submit…` function that takes the session's actor and the URL's slug (`modules/tenancy/organization-forms.ts`), a thin `"use server"` action around it, and an entry in `tenantForms` (`tests/isolation/tenant-operations.ts`). The form kit is `@/components/admin/form`. Until this issue an Owner has nobody to transfer to in a real organization: once invitations exist, add one browser test that goes invite → accept → transfer. In browser tests, look only at what is on screen (`.filter({ visible: true })` or a role locator): after a client-side navigation Next keeps the previous page in the document, hidden. `tests/e2e/helpers/orgs.ts` seeds and inspects organizations.*

**Depends on:** M3-3, M1-4

**Acceptance criteria:**
- [ ] `/{org}/members`: members table, pending invitations, invite dialog (email + role), resend, revoke
- [ ] `/invite/[token]`: sign in or sign up, email must match, single use, 7-day expiry
- [ ] Change role, remove member, leave org; last-Owner invariant enforced under a row lock; only an Owner can grant Owner
- [ ] Requires a verified email to invite

**Likely files/modules:** `src/modules/tenancy/{invitations,members}.*`, member pages

**Testing:** integration of the invariants under concurrency; E2E invite → accept → role enforced (an Author can't open settings).

### M3-5 · Audit log and activity page
**Labels:** `area:audit` `type:feature`

**Description:** Transactional audit trail.

*From M2-4: `modules/audit` already has `recordPlatformEvent()` for org-less account events (`auth.login`, `auth.logout`, `auth.password_changed`), written after Better Auth's own queries, so not in their transaction. Add `audit.record(tx, …)` for tenant mutations next to it. **No application role can read org-less rows**: the policy's `USING` clause needs an organization, and `FORCE ROW LEVEL SECURITY` applies it to the owner too. That is right for tenants; the staff console (M12-1) will need a definer function or a platform policy to read them. The integration tests read them as the owner with `FORCE` lifted inside a rolled-back transaction (`tests/integration/auth-account.test.ts`).*

*From M3-1: the tenancy services do not write audit rows yet (`audit.record` did not exist). Add them inside the same `inTenant(ctx, …)` transactions: organization created / renamed / slug changed, role changed, member removed or left, ownership handed over. The context already carries `requestId`, `ip` and the actor.*

*From M3-2 (ADR 0009): the activity page takes `org.activity.read` (Owner and Admin): `requirePermission(ctx, "org.activity.read")` in the query, not only in the page. A refused attempt (`Forbidden`) is not an audit event in V1.*

*From M3-3: the organization screens write no audit rows either: creating, renaming, changing the URL and transferring all go through the M3-1 services, so adding `audit.record(tx, …)` there covers the screens too. Add "Activity" to the organization's links for members who hold `org.activity.read`.*

**Depends on:** M3-1

**Acceptance criteria:**
- [ ] `audit_logs` table; `forge_app` has INSERT/SELECT only
- [ ] `audit.record(tx, { action, resourceType, resourceId, metadata })` taking actor, request ID and IP from the context
- [ ] `/{org}/activity`: paginated list with filters (site, user, action, date); Admin+

**Likely files/modules:** `src/modules/audit/*`, activity page

**Testing:** a rolled-back mutation leaves no audit row; UPDATE on `audit_logs` fails for `forge_app`.

---

## M4 — Sites

### M4-1 · Sites schema, create site, site address, limits
**Labels:** `area:sites` `type:feature`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** Sites and their site address (`/s/{address}` in V1; `{address}.<sites domain>` post-V1, ADR 0006).

*From M3-1: `modules/sites` has its read side (`findSiteBySlug`, `siteAddress`) and `requireSiteContext(orgSlug, siteSlug)` resolves a site for an admin request. A site's **slug** (admin URLs, unique per organization) and its **address** (public URLs, unique on the platform) are different values; the test factory still sets them equal. The database already refuses a duplicate address, an uppercase address, and a `domains` row whose site belongs to another organization (tested in `tests/integration/tenancy.test.ts`). `createSite` takes a context from the resolver and opens its transaction with `inTenant(ctx, …)`.*

*From M3-2 (ADR 0009): `createSite` takes `sites.create`, `deleteSite` takes `sites.delete` (Owner only), `changeSiteAddress` takes `site.settings.manage`. Order: `requirePermission` → `assertLimit` (the plan, a separate question from the role) → validate → write. Listing an organization's sites takes membership only.*

*From M3-3: `/{orgSlug}` is a small page for now (`src/app/(admin)/[orgSlug]/page.tsx`: the organization's name, the member's role, an empty "Sites" box). When `/{orgSlug}/sites` exists, turn it into the redirect plan §19 describes and add "Sites" to the shell's links. `/` (`src/app/(admin)/route.ts`) redirects to `homePath(...)`, which is `/{orgSlug}`; nothing else needs to change for it to reach the sites.*

**Depends on:** M3-2

**Acceptance criteria:**
- [ ] Tables `sites`, `site_settings`, `domains` (rows of kind `subdomain` whose `hostname` holds the address label; platform class)
- [ ] `createSite` in one transaction:
  - validates the site address (`isSiteAddress`: DNS-label shape ≤ 63; reserved words such as `www`, `app`, `api`, `admin`, `media`; uniqueness)
  - creates the site (`coming_soon`) + settings + `domains` row
  - checks the plan limit (`assertLimit` stub with plan in code)
  - audits
- [ ] `/{org}/sites` grid and `/{org}/sites/new`; `changeSiteAddress` (invalidates `host:{old}` and `host:{new}`), soft `deleteSite`

**Likely files/modules:** `src/modules/sites/*`, `src/modules/domains/schema.ts`, site pages

**Testing:** site address validation table; limit reached → `LimitExceeded`; isolation suite for sites.

### M4-2 · Site overview, settings and onboarding steps 2–3
**Labels:** `area:sites` `type:feature`

**Description:** Configure a site.

*From M3-3: `/onboarding` is step 1 only, and sends a user who already has an organization straight to it. Making the wizard resumable (plan §3) changes that one rule in `src/app/(admin)/onboarding/page.tsx`: an organization without a site continues at step 2 instead of leaving. After creating the organization the action redirects to `/{orgSlug}`; point it at step 2 here.*

**Depends on:** M4-1, M4-4

**Acceptance criteria:**
- [ ] `/{org}/sites/{site}` overview: status, primary URL, launch checklist (pages, menu, SEO, domain, publish), recent activity
- [ ] `/…/settings`: general (name, tagline, language, timezone, social links), reading (blog path, posts per page), analytics (GA4 ID, Plausible domain), with Zod-validated JSONB groups and optimistic `version`
- [ ] `/onboarding` steps 2 (site) and 3 (theme) reuse the same actions

**Likely files/modules:** site pages, `src/modules/sites/{settings,validation}.ts`

**Testing:** invalid GA4 ID rejected; E2E onboarding end to end.

### M4-3 · Renderer foundation: site address/host → site, coming soon, unknown and suspended sites
**Labels:** `area:rendering` `type:feature` `risk:high`

**Description:** Serve sites by their site address (V1: `/s/{address}`) or, post-V1, by hostname, with correct caching.

*From M0-4 and ADR 0006: start from `spikes/rendering/queries.ts` (`resolveSite(locator)`) and the current `/render/[site]/[[...path]]` page; build every link from `siteBasePath()`. Keep static params for both segments, resolve the host outside `<Suspense>` (real 404s), skip the database for the build placeholder, and delete the `/dev/cache` and `/api/dev/revalidate` spike routes (ADR 0002).*

**Depends on:** M1-7, M4-1

**Acceptance criteria:**
- [ ] `(sites)/render/[site]/layout.tsx` with `resolveSite(locator)` (`'use cache'`, tag `host:{address|hostname}`) → site, org, primary, status
- [ ] Unknown site → platform "site not found"; `suspended` → "site unavailable"; `coming_soon` → theme's coming-soon page with `noindex` (preview token bypass comes in M7-4)
- [ ] *(Host mode, post-V1)* Non-primary host → 308 to primary (except `/_forge/preview/*`)
- [ ] Cached data functions take `siteId`/`host` as arguments; lint rule for `'use cache'` functions without a tenant argument

**Likely files/modules:** `src/modules/rendering/*`, `src/app/(sites)/render/[site]/*`

**Testing:** E2E via `/s/{address}` on one host; an address change invalidates the `host:` tag; the site tree never imports `modules/auth` (lint).

### M4-4 · Theme kit, Studio skeleton, theme picker
**Labels:** `area:themes` `type:feature`

**Description:** The structure every theme follows.

**Depends on:** M1-1

**Acceptance criteria:**
- [ ] `src/themes/_kit`:
  - settings schema (colours, fonts, header, footer, layout)
  - CSS-variable builder from validated values
  - curated fonts via `next/font`
  - base components (Container, Nav, Prose)
- [ ] `ThemeManifest` type + registry; Studio skeleton: layout, header/footer (one variant each), coming-soon, not-found, default page template
- [ ] Theme picker (onboarding + `/…/appearance`) storing `sites.theme_key`; invalidates `site:{id}`

**Likely files/modules:** `src/themes/*`, `src/modules/sites/appearance.*`

**Testing:** unit: token schema rejects unsafe values; the CSS builder output is only variables.

### M4-5 · Publish site (coming soon → live)
**Labels:** `area:sites` `type:feature`

**Description:** The site-level go-live switch.

**Depends on:** M4-3, M2-2

**Acceptance criteria:**
- [ ] `setSiteStatus` (Admin+): `coming_soon` ↔ `live`; requires a verified email; audited; invalidates `site:{id}`
- [ ] Overview shows the state and the live URL

**Likely files/modules:** `src/modules/sites/*`, overview page

**Testing:** E2E: publish site → `/s/{address}` serves real pages (after M5), and the pages are no longer `noindex`.

---

## M5 — Content & editor

### M5-1 · Content schema
**Labels:** `area:content` `type:feature` `risk:high`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** The entry aggregate and terms.

**Depends on:** M3-2, M4-1

**Acceptance criteria:**
- [ ] Tables `entries`, `entry_drafts`, `entry_revisions`, `terms`, `entry_terms` per plan §4.2, with composite FKs (parent, featured media placeholder column, terms) and `ON DELETE SET NULL (col)` where specified
- [ ] Unique `(site_id, locale, path) WHERE deleted_at IS NULL`; list indexes; trigram index on draft titles
- [ ] `entry_revisions` has no UPDATE grant

**Likely files/modules:** `src/modules/content/schema.ts`, `drizzle/*`

**Testing:** isolation suite; a cross-site parent or term is rejected by the database.

### M5-2 · Content-type registry and path/slug service
**Labels:** `area:content` `type:feature`

**Description:** Page and post definitions and URL computation.

**Depends on:** M5-1

**Acceptance criteria:**
- [ ] `ContentTypeDefinition` interface + `page` and `post` definitions (plan §5)
- [ ] `slugify`, unique-slug with suffix retry on conflict, reserved path check (`/_forge`, `/sitemap.xml`, `/robots.txt`, blog path)
- [ ] Path builder: pages from parent chain (Home = `/`), posts from the blog path

**Likely files/modules:** `src/modules/content/types/*`, `src/modules/content/paths.ts`

**Testing:** unit tables for paths, slugs, reserved words, parent chains.

### M5-3 · Entry services: create, autosave, publish transaction
**Labels:** `area:content` `type:feature` `risk:high`

**Description:** The core write paths.

*From M3-2 (ADR 0009): add `modules/content/policies.ts`. Pages have plain keys (`entries.page.update`); posts have own/any pairs, for which `canActOn(ctx, "entries.post.update", { organizationId: entry.organizationId, ownerId: entry.authorId })` is the whole policy. Reading (`entries.{type}.read`) is held by every role. Build the key from the entry's type through the content-type registry, never from request input. Register each policy in `tenantPolicyChecks` (`tests/isolation/tenant-operations.ts`). A content type added to the registry needs its keys added to the catalog: a unit test fails until the catalog's entry types and `ENTRY_TYPES` agree.*

**Depends on:** M5-2, M3-5

**Acceptance criteria:**
- [ ] `createEntry` (type, title, parent/template) → entry + draft v1; Home page created automatically at site creation and set as homepage
- [ ] `saveDraft(entryId, expectedVersion, draft)` → `Conflict` on mismatch; content validated (allow-list, size and node limits)
- [ ] `publishEntry(entryId, expectedDraftVersion)` in one transaction:
  1. lock the entry
  2. idempotency check
  3. `publish` revision
  4. update the projection
  5. replace `entry_terms`
  6. audit
  7. return events
- [ ] Server Actions in `content/actions.ts` flush `invalidate(events)`

**Likely files/modules:** `src/modules/content/{entry,publishing}.service.ts`, repositories, actions

**Testing:** integration: atomicity (a failure mid-transaction leaves no partial state), idempotent retry, version conflict, concurrent publish serialised.

### M5-4 · Editor shell, text nodes, autosave and conflicts
**Labels:** `area:editor` `type:feature` `risk:high`

**Description:** The Tiptap editor per ADR 0003.

*From M0-5: start from `spikes/editor/`. Carry over the paste guard, the columns normalizer and the client-only (`ssr: false`) loading. Add client-side id dedupe before save (ADR 0003, gap 3).*

**Depends on:** M0-5, M5-3

**Acceptance criteria:**
- [ ] Editor route `/…/pages/[entryId]` and `/…/posts/[entryId]` (lazy-loaded bundle)
- [ ] Nodes: heading (2–4), paragraph, bullet/ordered list, blockquote, divider; marks: bold, italic, underline, strike, code, link (with an entry picker from `/api/app/entries/search`)
- [ ] Slash menu, stable IDs, allow-listed paste normalisation
- [ ] Autosave (2 s debounce, 30 s max) with status indicator; local buffer per entry + version; conflict dialog
- [ ] Title field; publish button (basic publish)

**Likely files/modules:** `src/modules/content/editor/*`, `src/blocks/{text-nodes}/*`

**Testing:** E2E type → reload → content persists; conflict between two tabs shows the dialog; paste of malicious HTML yields safe nodes.

### M5-5 · Custom blocks, properties panel, reordering
**Labels:** `area:editor` `type:feature`

**Description:** The structural blocks.

*From M0-5: button, columns, embed and spacer already exist in `spikes/editor/`. Decided 2026-10-01 (plan §6.1, §6.3):*
- *Embeds: YouTube and Vimeo, plus a `generic` https iframe URL only after URL-safety validation (`platform/net/url-safety` must exist first). No provider-specific integrations.*
- *Top-level drag snaps to the gaps between top-level blocks, with a visible insertion gap. Drops into containers keep ProseMirror's behaviour.*

**Depends on:** M5-4

**Acceptance criteria:**
- [ ] Block registry entries (`schema`, Tiptap extension, NodeView, render) for `button`, `columns`/`column` (2–3, no nesting), `embed` (YouTube, Vimeo with privacy URLs; `generic` iframe URL after URL-safety validation), `spacer`
- [ ] Properties side panel generated from each block's Zod schema
- [ ] Drag handle reorder + Alt+↑/↓ + block menu (move, duplicate, delete)
- [ ] `v` attribute + `migrate` scaffold per custom block

**Likely files/modules:** `src/blocks/{button,columns,embed,spacer}/*`, `src/modules/content/editor/panel/*`

**Testing:** unit: schema validation and migrate; E2E build a two-column section with a button and reorder it.

### M5-6 · Closed renderer, theme templates, public routing
**Labels:** `area:rendering` `type:feature` `risk:high`

**Description:** Render published content on sites.

**Depends on:** M5-3, M4-3, M4-4

**Acceptance criteria:**
- [ ] Closed node → React renderer (no `dangerouslySetInnerHTML`); `entry:{id}` links resolved to live paths; unknown nodes skipped
- [ ] `resolveRoute` (cached): homepage, pages by path, blog index, post, category/tag archives, pagination, 404
- [ ] Studio templates: page (default, full-width, landing), post, blog index, term archive
- [ ] Cache tags `routes`, `entry`, `list:{type}` applied; publish invalidation verified

**Likely files/modules:** `src/modules/rendering/*`, `src/themes/studio/templates/*`, `src/themes/_kit/blocks/*`

**Testing:** renderer XSS corpus; E2E publish → visible; edit + republish → updated without purge.

### M5-7 · Pages and posts admin: lists, new forms, entry sidebar
**Labels:** `area:content` `type:feature`

**Description:** Everything around the editor.

**Depends on:** M5-4

**Acceptance criteria:**
- [ ] `/…/pages`: tree list (drag to reorder siblings; set parent), search, status filter
- [ ] `/…/posts`: list with filters (status, category, author), search, sort
- [ ] `/…/pages/new`, `/…/posts/new` forms (title + parent/template) → action → redirect to the editor
- [ ] Editor sidebar: slug, parent, template, excerpt, author (Editor+), categories/tags, featured image slot (wired in M6-4); "Set as homepage"
- [ ] Authors see and edit only their own posts; pages hidden from Authors

**Likely files/modules:** page/post routes, `src/modules/content/queries.ts`, `ui/*`

**Testing:** E2E Author permissions; list filters.

### M5-8 · Categories and tags
**Labels:** `area:content` `type:feature`

**Description:** Taxonomy management and assignment.

**Depends on:** M5-3

**Acceptance criteria:**
- [ ] `/…/posts/categories` (hierarchical, one level of nesting) and `/…/posts/tags`: create, rename (slug change → archive redirect in M8-5), delete (shows usage count)
- [ ] Assignment in the editor sidebar writes `entry_drafts.term_ids`; `entry_terms` replaced on publish
- [ ] Authors can assign existing terms and create tags

**Likely files/modules:** `src/modules/content/{term.service,term.repository}.ts`, term pages

**Testing:** a draft term change doesn't alter the live archive until publish; isolation.

---

## M6 — Media

### M6-1 · Media schema and upload protocol
**Labels:** `area:media` `type:feature`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** Direct-to-storage uploads with validation.

*From M1-5 (ADR 0008):*
- *Use `storageFor({ organizationId, siteId })` from the request's tenant context, and `mediaObjectKey()` for keys.*
- *`createUpload` already signs type and size; `head` + `readRange` serve `completeUpload`.*
- *The `/media/{key}` route (M6-2) reads with `platformStorage().get()`.*
- *Delete the `/api/dev/storage` dev route once real uploads exist.*

*From M3-2 (ADR 0009): `requestUploads` takes `media.upload`. Updating and deleting are own/any pairs: `canActOn(ctx, "media.delete", { organizationId: item.organizationId, ownerId: item.uploadedBy })`. An item whose uploader was deleted (`uploaded_by` NULL) is nobody's own: only `.any` reaches it.*

**Depends on:** M1-5, M3-2

**Acceptance criteria:**
- [ ] Tables `media_folders`, `media_assets`
- [ ] `requestUploads(files)`: type and size checks, storage limit check, `pending` rows, presigned PUTs (10 min)
- [ ] `completeUpload(mediaId)`: HEAD size match, magic-byte sniff, mismatch → delete + `failed`
- [ ] `uploads.cleanup` daily job for `pending` rows older than 24 h

**Likely files/modules:** `src/modules/media/*`

**Testing:** integration against MinIO: happy path, spoofed type, oversize, quota race.

### M6-2 · Image processing and CDN delivery
**Labels:** `area:media` `type:feature`

**Description:** Synchronous variants and fast delivery.

*From M2-4: the account avatar moved here. It is a user-level image (no organization): store it through `platformStorage()` under a user prefix (e.g. `u/{userId}/…`), run it through `processImage` (square thumb, metadata stripped), serve it from `/media/{key}`, and set `users.image` to that URL. `/update-user` currently accepts the name only (`EDITABLE_PROFILE_FIELDS` in `modules/auth/auth.ts`): set the image on the server from the upload, never from a URL the browser sends. The account page (`src/app/(admin)/account/page.tsx`) and `AccountMenu` show initials until then; a Google account may carry Google's picture URL in `users.image`, which is not displayed.*

**Depends on:** M6-1

**Acceptance criteria:**
- [ ] `processImage(mediaId)` inside `completeUpload`: `sharp` with `limitInputPixels`, auto-rotate, metadata stripped; widths 400 (square thumb), 800, 1600, 2400 (≤ original) as WebP → `variants` JSONB
- [ ] Route `maxDuration`/memory configured; p95 processing time logged
- [ ] Account avatar on `/account`: upload via the storage driver, processed and served like other media *(moved from M2-4)*
- [ ] V1 delivery at `/media/{key}` (ADR 0006): a route handler streams the object from storage with `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and only allow-listed MIME types (never HTML/JS/SVG); unknown keys → 404. A CDN domain is post-V1 via `MEDIA_PUBLIC_BASE_URL`
- [ ] A `<ResponsiveImage>` kit component produces `srcset`/`sizes`/`width`/`height`

**Likely files/modules:** `src/modules/media/processing.ts`, `src/app/media/[...key]/route.ts`, `src/themes/_kit/components/ResponsiveImage.tsx`

**Testing:** integration: EXIF GPS absent in variants; a 60 MP image rejected; srcset output snapshot.

### M6-3 · Media library UI
**Labels:** `area:media` `type:feature`

**Description:** Manage media.

**Depends on:** M6-2

**Acceptance criteria:**
- [ ] `/…/media`: dropzone multi-upload with per-file progress and retry
- [ ] Grid and list views; folder sidebar (one level): create, rename, delete-empty, move
- [ ] Trigram search over title/filename/alt; filter by kind and folder; sort by newest, name, size
- [ ] Detail drawer: edit title, alt, caption; copy URL; trash/restore; `trash.purge` removes objects after 30 days
- [ ] Authors manage their own uploads only

**Likely files/modules:** media page, `src/modules/media/ui/*`, `src/app/api/app/media/*`

**Testing:** E2E upload 3 images + 1 PDF, search, move to a folder, trash and restore.

### M6-4 · Media picker, image block, featured/OG/logo/favicon
**Labels:** `area:media` `area:editor` `type:feature`

**Description:** Use media everywhere.

**Depends on:** M6-3, M5-5

**Acceptance criteria:**
- [ ] Picker modal (library + upload) reused across the admin
- [ ] `image` block (`mediaId`, alt override, caption, size, link) rendered with `ResponsiveImage`; missing or trashed media renders nothing
- [ ] Featured image on posts; OG image field (SEO, M8-4); logo and favicon in site settings (favicon sizes generated)
- [ ] Composite FK prevents using another site's media

**Likely files/modules:** `src/blocks/image/*`, `src/modules/media/ui/picker/*`, settings pages

**Testing:** E2E insert an image in a page → live `srcset` from the CDN.

---

## M7 — Publishing

### M7-1 · Lifecycle: unpublish, trash, restore, purge
**Labels:** `area:content` `type:feature`

**Description:** The state machine and its actions.

**Depends on:** M5-3

**Acceptance criteria:**
- [ ] `lifecycle.ts` pure state machine (draft / scheduled / published + trash) with permission per transition
- [ ] `unpublishEntry` (+ optional "redirect this URL to…"), `trashEntry` (unpublishes in the same transaction, frees the path), `restoreEntry` (→ draft, slug re-suffixed), `purgeEntry`
- [ ] `trash.purge` daily job (30 days); trash filter in lists

**Likely files/modules:** `src/modules/content/lifecycle.ts`, `publishing.service.ts`, lists

**Testing:** unit transition table; integration: trash → path reusable; restore conflict suffix.

### M7-2 · Scheduling via jobs
**Labels:** `area:content` `type:feature`

**Description:** Timed publishing of a frozen revision.

*V1 (ADR 0006): on Vercel Hobby the job runs when the runner is next called. That is the minute scheduler (optional, free, external) or the daily cron. Without a scheduler, a post can publish up to a day late: a known V1 limitation.*

**Depends on:** M7-1, M1-3

**Acceptance criteria:**
- [ ] `scheduleEntry(entryId, runAt, expectedVersion)`: validates as for publish, creates a `scheduled` revision, enqueues `entry.publish_scheduled` (`dedupe_key = entry:{id}`), status `scheduled`
- [ ] `cancelSchedule`; the job publishes the frozen revision through the same function and invalidates with `revalidateTag(..., { expire: 0 })`
- [ ] Schedule dialog in the site timezone; scheduled list on the site overview; failed job → email to the scheduler + banner

**Likely files/modules:** `src/modules/content/scheduling.*`, `src/platform/jobs/registry.ts`

**Testing:** fake-clock integration: runs within one tick; a draft edited after scheduling does not leak into the scheduled publish; E2E via the cron route.

### M7-3 · Revisions: manual save, history, restore
**Labels:** `area:content` `type:feature`

**Description:** Snapshot history.

**Depends on:** M5-3

**Acceptance criteria:**
- [ ] "Save" creates a `save` revision (deduped by content hash); cap by plan; publish revisions always kept
- [ ] History drawer: number, kind, author, time, label, live marker
- [ ] `restoreRevision` copies into the draft (+ a `restore` revision), never publishes; flags missing media

**Likely files/modules:** `src/modules/content/revision.*`, editor drawer

**Testing:** integration: restore → draft equals the revision content; the published version is unchanged.

### M7-4 · Preview
**Labels:** `area:rendering` `type:feature`

**Description:** Private draft preview. V1: on the app host (ADR 0006); post-V1: on the site's platform subdomain.

**Depends on:** M5-6

**Acceptance criteria:**
- [ ] `createPreviewToken(entryId)`: HMAC (`PREVIEW_TOKEN_SECRET`), 15 min, bound to site + entry + user
- [ ] `/_forge/preview/{token}` (V1: `cms.forgelinetechnologies.com/_forge/preview/{token}`, rewritten by the proxy into the site renderer; the token alone identifies site + entry) renders the draft via **uncached** queries, with `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`; `frame-ancestors 'self'`
- [ ] Editor preview pane (iframe) + "open in new tab"; autosave flushed before preview; works for coming-soon sites

**Likely files/modules:** `src/modules/rendering/preview.*`, `src/app/(sites)/render/[site]/…/preview/*`, `src/platform/routing/hosts.ts`

**Testing:** tampered or expired token → 404; response headers asserted; E2E preview shows unpublished changes.

---

## M8 — Website: themes, navigation, SEO

### M8-1 · Appearance customisation
**Labels:** `area:themes` `type:feature`

**Description:** Branding controls.

**Depends on:** M4-4, M6-4

**Acceptance criteria:**
- [ ] `/…/appearance`: logo, colours (4 tokens with a contrast warning), fonts (heading/body), header variant + sticky + CTA, footer variant + copyright + social toggle, layout (width, radius, density)
- [ ] Live preview iframe using a preview token with unsaved settings
- [ ] Saved to `site_settings.theme`; invalidates `site:{id}:config`
- [ ] Studio gets all header (3) and footer (2) variants

**Likely files/modules:** appearance page, `src/themes/_kit/*`, `src/themes/studio/components/*`

**Testing:** unit: invalid tokens rejected; E2E change colour → live site updated.

### M8-2 · Journal theme
**Labels:** `area:themes` `type:feature`

**Description:** The second, blog-first theme on the kit.

**Depends on:** M8-1

**Acceptance criteria:**
- [ ] Manifest, templates (page, post, blog index, archives, not found, coming soon), styles
- [ ] Switching Studio ↔ Journal keeps kit-level settings
- [ ] Lighthouse ≥ 90 performance and accessibility on a fixture site

**Likely files/modules:** `src/themes/journal/*`

**Testing:** E2E theme switch; axe checks on templates.

### M8-3 · Menus
**Labels:** `area:navigation` `type:feature`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** Header and footer navigation.

**Depends on:** M5-6

**Acceptance criteria:**
- [ ] `menus` table (one per `header`/`footer`), `items` JSONB validated (depth ≤ 2, ≤ 100 items; kinds `entry`, `term`, `archive`, `url`; no `javascript:`)
- [ ] `/…/menus` tree editor: add from page/post/category search or URL, drag to reorder and nest, label override, new-tab toggle
- [ ] Themes render menus; items pointing at unpublished or trashed entries are omitted; invalidates `config`

**Likely files/modules:** `src/modules/navigation/*`, menus page, `src/themes/_kit/components/Nav*`

**Testing:** unit: schema validation; E2E trash a linked page → menu item disappears from the live site.

### M8-4 · SEO: resolver, editor panel, site defaults, sitemap, robots, JSON-LD
**Labels:** `area:seo` `type:feature`

**Description:** Search-ready output.

**Depends on:** M5-6, M6-4

**Acceptance criteria:**
- [ ] `resolveSeo()` pure function with field-level precedence and safety overrides (coming soon, preview, non-production, discourage indexing)
- [ ] Editor SEO tab: title, description, canonical (absolute https), OG image, noindex/nofollow, with "inherited from…" hints and length counters
- [ ] `/…/seo`: title template, default description, default OG image, discourage indexing, Search Console token
- [ ] Output: meta, canonical, OG/Twitter, JSON-LD (`WebSite`, `Organization`, `WebPage`/`BlogPosting`, `BreadcrumbList`) with `<` escaped
- [ ] Per-site sitemap (V1: `/s/{address}/sitemap.xml`; published, indexable, non-empty archives). Path mode: the host's `/robots.txt` allows `/s/`, lists live sites' sitemaps, and disallows `/api/`; a site that discourages indexing gets `noindex` meta and is left out. Host mode (post-V1): `/robots.txt` per host. Canonical/OG URLs are built from the site's base (`/s/{address}` in V1)

**Likely files/modules:** `src/modules/seo/*`, `src/app/(sites)/render/[site]/…/sitemap.xml/*`, `src/app/robots.ts`

**Testing:** resolver table tests; sitemap excludes drafts and noindex; JSON-LD escaping test.

### M8-5 · Redirects, auto-redirects, custom 404
**Labels:** `area:seo` `type:feature`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** URLs never break.

**Depends on:** M8-4, M7-1

**Acceptance criteria:**
- [ ] `redirects` table; `/…/seo/redirects` CRUD (exact match; 301/302/307/308; active toggle)
- [ ] Validation: leading `/`, not reserved, no self-redirect, loop detection (depth 10), chains flattened on write
- [ ] Auto 301 on published path change (slug, parent, blog path, term slug) in the publish transaction; publishing at a redirected path deactivates that redirect with a notice
- [ ] Cached redirect map checked first in route resolution
- [ ] Custom 404 page setting

**Likely files/modules:** `src/modules/seo/redirects.*`, rendering route resolution

**Testing:** unit loop/flatten cases; E2E rename slug → old URL 301s.

---

## M9 — Custom domains *(post-V1 infrastructure)*

> **Deferred (ADR 0006).** Not built on the zero-cost V1 deployment: no wildcard tenant domains, Vercel Domains API, automated SSL, domain-ownership automation or `domain.check` polling. The `domains` model, host-mode routing (`HOST_ROUTING_ENABLED`) and `host:` cache tags exist, so this milestone needs paid hosting but no content or tenancy changes. These issues stay as written for that time.

### M9-1 · Domain provider, service and verification
**Labels:** `area:domains` `type:feature` `risk:high`

**Description:** Secure domain claiming (plan §11).

**Depends on:** M4-3, M1-3

**Acceptance criteria:**
- [ ] `DomainProvider` interface + Vercel implementation (add, get config/verification, verify, remove) + fake for tests
- [ ] `addDomain(host)`: normalisation + PSL; rejects platform or active hosts; creates the apex + www pair with tokens; calls the provider; plan gate (Pro/trial); verified email required
- [ ] TXT check via `dns.promises.resolveTxt` on `_forge-challenge.<apex>`
- [ ] `domain.check` job with backoff; `verifyDomainNow`; pending claims expire after 7 days; statuses per plan §4.2

**Likely files/modules:** `src/modules/domains/*`

**Testing:** lifecycle with the fake provider; TXT mismatch; a second org can't claim an active host; expiry.

### M9-2 · Domains UI, primary domain, canonical redirects
**Labels:** `area:domains` `type:feature`

**Description:** Customer-facing domain management.

**Depends on:** M9-1

**Acceptance criteria:**
- [ ] `/…/domains`: subdomain (editable), custom domains with per-record DNS instructions from the provider response, copy buttons, live status, SSL state
- [ ] `setPrimaryDomain` (apex or www): the other host gets the provider-level 308; the renderer 308s all non-primary hosts; canonical/sitemap/OG use the primary; host tags invalidated
- [ ] `removeDomain`: detach from Vercel first, then delete; site deletion detaches domains first

**Likely files/modules:** domains page, `src/modules/domains/*`, rendering

**Testing:** E2E with the fake provider; one manual run with a real domain on staging (documented).

---

## M10 — REST API v1

### M10-1 · API keys, `withApi`, read endpoints
**Labels:** `area:api` `type:feature`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** Safe read access for other systems.

**Depends on:** M5-6, M6-2

**Acceptance criteria:**
- [ ] `api_keys` table + `resolve_api_key(hash)`; `/…/settings/api-keys`: create (shown once, `fk_live_` prefix), scope `read`/`write`, revoke, last used
- [ ] `withApi({ scope })`: bearer auth, site-match check, rate limit per key (`checkRateLimit`), Zod input, `problem+json` errors, request ID
- [ ] Read endpoints (plan §15): sites, pages, posts (list/detail/by-path, `content` + `contentHtml`), media, menus, categories, tags; cursor pagination

**Likely files/modules:** `src/modules/api/*`, `src/app/api/v1/**`

**Testing:** scope and site-mismatch cases; revoked key 401; key for site A can't read site B (404); pagination stability.

### M10-2 · Write endpoints and OpenAPI
**Labels:** `area:api` `type:feature`

**Description:** Basic content management over the API.

**Depends on:** M10-1, M7-1

**Acceptance criteria:**
- [ ] `POST`/`PATCH` (with `If-Match`) /`DELETE` pages and posts; `POST …/publish`, `…/unpublish`, all through the existing services (audited as `api_key` actor)
- [ ] `/api/v1/openapi.json` generated from Zod schemas; short API docs page in the repo
- [ ] CI snapshot of the OpenAPI document (diff shows in PRs)

**Likely files/modules:** `src/app/api/v1/**`, `src/modules/api/openapi.ts`, `docs/api.md`

**Testing:** `If-Match` 412; publish via the API invalidates the site cache; audit actor recorded.

---

## M11 — Billing

### M11-1 · Plans, limits, trial lifecycle
**Labels:** `area:billing` `type:feature`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** Entitlements without Stripe.

*From M3-2 (ADR 0009): entitlements are a separate axis from roles. `assertLimit` runs after `requirePermission` and before validation, and knows nothing about roles; the permission catalog has no plan keys and must not gain any. `org.billing.manage` (Owner only) is the permission to open billing, not a statement about the plan.*

*From M3-3: every organization a user creates starts its own 14-day Pro trial, and `createOrganization` does not limit how many a user may create. No screen offers a second organization yet (onboarding is the first run only), but the Server Action behind it would accept one. Decide here whether creating further organizations is a product feature (then it needs a screen and a rule about trials) or is refused.*

**Depends on:** M3-1

**Acceptance criteria:**
- [ ] `plans.ts` (Free, Pro; illustrative limits in plan §14); `entitlements(org)` from the subscription row
- [ ] `assertLimit(tx, org, key)` (org row lock + count/sum) wired into: create site, invite member, request uploads, add domain, create API key
- [ ] Daily `trial.expire` job → `free` + 7-day grace → over-limit handling (extra sites to coming soon, custom domains show "requires Pro"; nothing deleted); upgrade restores instantly
- [ ] "Powered by Forge" badge on Free sites (theme kit)

**Likely files/modules:** `src/modules/billing/{plans,limits,trial}.ts`

**Testing:** limit boundaries and races; trial expiry with a fake clock; over-limit → upgrade → restored.

### M11-2 · Stripe checkout, portal, webhook sync, billing UI
**Labels:** `area:billing` `type:feature`

**Description:** Take payment.

**Depends on:** M11-1

**Acceptance criteria:**
- [ ] `startCheckout` (subscription mode, `client_reference_id` + metadata `organization_id`), `openBillingPortal`
- [ ] `/api/webhooks/stripe`: signature verified over the raw body → re-fetch the subscription → idempotent upsert → audit; errors return 500 for Stripe retry
- [ ] `/{org}/billing` (Owner): plan, trial days left, status, upgrade, manage billing; banners for trial ending, past due and grace

**Likely files/modules:** `src/modules/billing/stripe.ts`, `src/app/api/webhooks/stripe/route.ts`, billing page

**Testing:** fixture events (duplicate, out of order) converge; E2E in Stripe test mode: trial → pay → cancel.

---

## M12 — Launch hardening

### M12-1 · Security pass, staff console, observability and runbooks
**Labels:** `area:ops` `type:infra` `risk:high`

**Description:** Make it safe to operate.

*From M3-3: under `/{orgSlug}` the 404 and "no access" pages reach a signed-in visitor with HTTP 200, because the admin shell streams before the membership is known (Cache Components). If real 404/403 status codes are wanted for the admin, the check has to happen in `proxy.ts` before rendering; that means a membership query per admin request there, so weigh it. Also: `/favicon.ico` and other stray first segments now reach the `[orgSlug]` route (answered as 404 without touching the session or the database); a real favicon would stop the request altogether.*

**Depends on:** all feature milestones

**Acceptance criteria:**
- [ ] Admin nonce-based CSP via the proxy; security headers per surface (V1: admin paths vs `/s/*` on one origin. Framing headers already exist; add `script-src`, and verify no tenant-controlled script can reach the origin, ADR 0006); WAF rules for `/api/auth/*`, `/api/v1/*` (Hobby allows 3 custom rules)
- [ ] Isolation suite covers 100% of tenant tables; actions and API routes registered for the 404 checks; `npm audit` clean of high/critical findings; OWASP ZAP baseline on staging (external pentest if budget allows)
- [ ] `/platform` staff console (allow-list `PLATFORM_ADMIN_EMAILS` + verified email): search orgs/sites, suspend/unsuspend with a reason (audited, invalidates `site:{id}`)
- [ ] Alerts (5xx rate, cron heartbeat, dead jobs, domain failures, Stripe webhook failures) and uptime checks (admin, API, a canary site at `/s/{address}`; custom domain post-V1)
- [ ] Runbooks: tenant restore via a Neon PITR branch (rehearsed once), domain troubleshooting, Stripe issues, incident basics

**Likely files/modules:** `src/proxy.ts`, `next.config.ts`, `src/app/(admin)/platform/*`, `docs/runbooks/*`

**Testing:** header assertions in E2E; the restore rehearsal is documented.

### M12-2 · Performance, accessibility, V1 acceptance suite, launch
**Labels:** `area:ops` `type:test`

**Description:** Prove the V1 Definition of Done (plan §23) and go live.

**Depends on:** M12-1

**Acceptance criteria:**
- [ ] Playwright acceptance suite automates the full §23 journey with two tenants on staging; manual run with real domains recorded
- [ ] Lighthouse ≥ 90 on both themes; public cache hit after the first view; publish-to-live < 5 s; admin p95 < 500 ms on staging data
- [ ] axe: no serious or critical issues on admin key screens and theme templates
- [ ] Light k6 test on renderer cache misses and publish
- [ ] Legal pages, production checklist, launch sign-off

**Likely files/modules:** `tests/e2e/acceptance/*`, `docs/runbooks/launch-checklist.md`

**Testing:** the acceptance suite is green on the release candidate.
