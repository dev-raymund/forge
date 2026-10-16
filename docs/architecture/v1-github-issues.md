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

**Status:** ✔ done (2026-10-07). See the M3-4 addenda in ADR 0001, ADR 0004, ADR 0007 and ADR 0009.

**Description:** Invite users and manage roles.

*From M3-1: `listMembers`, `changeMemberRole`, `removeMember` and `leaveOrganization` exist with the last-Owner rule under a row lock, and are tested under concurrency. This issue adds invitations and the screens. `acceptInvitation` must insert the membership inside the invited organization's tenant context (`withTenant` with the organization id that `resolve_invitation()` returned): since migration 0004 a membership cannot be written from a user-only context. A member is named by membership id, never by user id.*

*From M3-2 (ADR 0009): inviting takes `org.members.manage` (`requirePermission(ctx, "org.members.manage")` first, then the plan limit, then validation). The two rules that are not permissions apply to invitations too: only an Owner may invite someone as an Owner. The members screen uses `canManageMembers(ctx)` to decide what to show; the role select must not offer Owner to an Admin, and the service refuses it regardless.*

*From M3-3: the organization shell exists (`src/app/(admin)/[orgSlug]/layout.tsx`). Add "Members" to its links (every member may read the list; managing takes `canManageMembers(ctx)`), and start the page with `requireOrgPage(orgSlug, …)`: a unit test fails for a page under `[orgSlug]` that does not. Follow the forms' shape: logic in a `submit…` function that takes the session's actor and the URL's slug (`modules/tenancy/organization-forms.ts`), a thin `"use server"` action around it, and an entry in `tenantForms` (`tests/isolation/tenant-operations.ts`). The form kit is `@/components/admin/form`. Until this issue an Owner has nobody to transfer to in a real organization: once invitations exist, add one browser test that goes invite → accept → transfer. In browser tests, look only at what is on screen (`.filter({ visible: true })` or a role locator): after a client-side navigation Next keeps the previous page in the document, hidden. `tests/e2e/helpers/orgs.ts` seeds and inspects organizations.*

**Depends on:** M3-3, M1-4

**Acceptance criteria:**
- [x] `/{org}/members`: members table, pending invitations, invite dialog (email + role), resend, revoke *(every member sees the list; the controls and the pending invitations are for those with `org.members.manage`)*
- [x] `/invite/[token]`: sign in or sign up, email must match, single use, 7-day expiry *(the account's own address, from the database, must be the invited one; sign-up and login carry the invitation along and return to it)*
- [x] Change role, remove member, leave org; last-Owner invariant enforced under a row lock; only an Owner can grant Owner *(the services are M3-1's, unchanged; the screens and forms are new)*
- [x] Requires a verified email to invite *(and to re-send; not to revoke, or to manage existing members)*

**Decisions taken here (the plan left them open; all are in the ADR addenda):**
- **Nobody is invited as an Owner, and no role drop-down offers Owner.** The assignable roles are Admin, Editor, Author and Viewer. Ownership changes only through the transfer in the settings. This is stricter than the M3-2 hand-off above ("only an Owner may invite someone as an Owner"): a link in an email never carries the organization itself. The M3-1 service rule that an Owner can make another Owner is unchanged; no screen uses it.
- **Accepting does not need a verified email.** The plan says "email must match". The link went to that address, so holding it is the proof of the mailbox; the account must carry the same address. If you want verification as well, it is one check in `acceptInvitation`.
- **The same address twice:** already a member → refused; an invitation still pending → refused, with "send it again or revoke it"; an invitation that expired unused → replaced by the new one.
- **Re-send makes a new link** for another 7 days and the old link stops working (the raw token is never stored, so it cannot be sent twice). At most once a minute per invitation.
- **Pending invitations are shown to managers only**, not to every member.
- **A link that cannot be accepted** (used, revoked, expired, unknown, or to a suspended organization) names no organization and nobody's address.
- **Seat limits are not checked.** Plan §14 counts members plus pending invitations per plan; that is `assertLimit` in M11-1, and `inviteMember` has the place for it (after the permission and the verified-email check, before validation).

**Also delivered:**
- Sign-up and login accept `next` and a starting `email` in the query. After sign-up with a destination the user continues to it instead of the "verify your email" screen (the verification email is still sent, and the app shows its banner).
- Sentry: an invitation token is in the URL path, so the scrubber now replaces `/invite/{token}` wherever a URL or message could carry it. Query strings were already dropped.
- A leaving member is redirected to their next page (another organization, or onboarding) rather than to `/`: a form's redirect has to name a page, and `/` is a route handler.
- A race in the M0-5 editor browser test ("copy/paste inside the editor re-ids the copies"): it pasted before the editor had registered the collapsed selection, and failed on a busy machine. It now waits for the editor's own selection.

**Likely files/modules:** `src/modules/tenancy/{invitations,members}.*`, member pages

**Testing:** integration of the invariants under concurrency; E2E invite → accept → role enforced (an Author can't open settings).

✔ `tests/e2e/members.spec.ts` (10: invite an existing user, invite a new person, the wrong account, resend/revoke/expiry, role change, remove and leave, invite → accept → transfer, cross-tenant, unverified manager, a phone), `tests/integration/invitations.test.ts` (39, real Postgres, with the email job run against a capturing provider), `tests/integration/isolation.test.ts` (92, +32), `src/modules/tenancy/invitation-rules.test.ts` (13), `src/modules/tenancy/members-view.test.ts` (8), `src/modules/tenancy/ui/ui.test.tsx` (+8), `src/modules/auth/ui/ui.test.tsx` (+3), `src/platform/observability/scrub.test.ts` (+1), `tests/unit/organization-pages.test.ts` (53, +13: the new files and the members route are under the same two source-level rules).

### M3-5 · Audit log and activity page
**Labels:** `area:audit` `type:feature`

**Status:** ✔ done (2026-10-07). See ADR 0010.

**Description:** Transactional audit trail.

*From M2-4: `modules/audit` already has `recordPlatformEvent()` for org-less account events (`auth.login`, `auth.logout`, `auth.password_changed`), written after Better Auth's own queries, so not in their transaction. Add `audit.record(tx, …)` for tenant mutations next to it. **No application role can read org-less rows**: the policy's `USING` clause needs an organization, and `FORCE ROW LEVEL SECURITY` applies it to the owner too. That is right for tenants; the staff console (M12-1) will need a definer function or a platform policy to read them. The integration tests read them as the owner with `FORCE` lifted inside a rolled-back transaction (`tests/integration/auth-account.test.ts`).*

*From M3-1: the tenancy services do not write audit rows yet (`audit.record` did not exist). Add them inside the same `inTenant(ctx, …)` transactions: organization created / renamed / slug changed, role changed, member removed or left, ownership handed over. The context already carries `requestId`, `ip` and the actor.*

*From M3-2 (ADR 0009): the activity page takes `org.activity.read` (Owner and Admin): `requirePermission(ctx, "org.activity.read")` in the query, not only in the page. A refused attempt (`Forbidden`) is not an audit event in V1.*

*From M3-3: the organization screens write no audit rows either: creating, renaming, changing the URL and transferring all go through the M3-1 services, so adding `audit.record(tx, …)` there covers the screens too. Add "Activity" to the organization's links for members who hold `org.activity.read`.*

*From M3-4: the changes to record, each inside the transaction that makes it (all already run under `inTenant` or `withTenant` with the organization lock held):*

| Action | Where | Notes |
|---|---|---|
| `member.invited` | `inviteMember` (`invitations.service.ts`) | resource: the invitation; metadata: role. The invited address is personal data: decide whether it goes in metadata |
| `invitation.resent`, `invitation.revoked` | `resendInvitation`, `revokeInvitation` | |
| `invitation.accepted` | `acceptInvitation` | the actor is the person joining, who has no context: take the organization from the transaction, and the request id from the action |
| `member.role_changed` | `changeMemberRole` (`members.service.ts`) | metadata: from, to |
| `member.removed` | `removeMember` | |
| `organization.left` | `leaveOrganization` | |
| `organization.ownership_transferred` | `transferOwnership` | |

*Never put an invitation token, its hash or its link in an audit row.*

**Depends on:** M3-1

**Acceptance criteria:**
- [x] `audit_logs` table; `forge_app` has INSERT/SELECT only *(both from M1-1; verified here in every context, with TRUNCATE)*
- [x] `audit.record(tx, { action, resourceType, resourceId, metadata })` taking actor, request ID and IP from the context *(the actor and the organization are read from the transaction's own context in SQL, so they cannot be passed at all; request id and address come from the request's context)*
- [x] `/{org}/activity`: paginated list with filters (site, user, action, date); Admin+ *(25 a page by cursor; filters for event, person and day in the form; `site` is read from the URL and applied, and gets its drop-down with the first site-level events, M4-1)*

**Decisions taken here (ADR 0010):**
- **Event names follow the owner's M3-5 instruction where it differs from the table above:** leaving is `member.left` (the table says `organization.left`), and a rename and a URL change are both `organization.updated`, told apart by their details.
- **An audit failure fails the change** (D-30). Tested for all eleven mutations.
- **Stored and shown are different things.** The request's address and id are stored; the activity page's query does not select them, or any user id.
- **Not recorded:** a refused attempt; a change that changes nothing; the expired invitation that a new invitation to the same address replaces (the new `member.invited` is the record).
- **Nothing is ever deleted.** No retention job exists in V1.

**Also delivered:**
- A typed event vocabulary (`modules/audit/events.ts`): ten events, each with a schema of what may be stored and a sentence for the page.
- `listActivity(ctx, query)` in the tenancy module holds the permission check (`org.activity.read`); the audit module holds the rows and depends on no other module.
- A bug found by a browser test: after "Clear filters" the form's fields kept the old values. The form is now keyed by the filters in the URL.
- A bug found by CI (ADR 0004, M3-5 addendum): a `<Link>` to `/` was prefetched, `/` is a route handler, and against a session that had just been revoked the prefetch removed its cookie before the user did anything. Links to `/` are no longer prefetched (`linkPrefetch`). It dates from M3-3; nothing in the audit log caused it.

**Likely files/modules:** `src/modules/audit/*`, activity page

**Testing:** a rolled-back mutation leaves no audit row; UPDATE on `audit_logs` fails for `forge_app`.

✔ `tests/integration/audit.test.ts` (34), `tests/integration/isolation.test.ts` (97, +5), `tests/e2e/activity.spec.ts` (6), `src/modules/audit/events.test.ts` (32), `src/modules/audit/activity-query.test.ts` (9), `src/modules/audit/ui/ui.test.tsx` (9), `tests/unit/audit-writer.test.ts` (4), `src/modules/tenancy/policies.test.ts` (+1), `tests/unit/organization-pages.test.ts` (56, +3: the activity route and service are under the same source-level rules).

---

## M4 — Sites

### M4-1 · Sites schema, create site, site address, limits
**Labels:** `area:sites` `type:feature`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** Sites and their site address (`/s/{address}` in V1; `{address}.<sites domain>` post-V1, ADR 0006).

*From M3-1: `modules/sites` has its read side (`findSiteBySlug`, `siteAddress`) and `requireSiteContext(orgSlug, siteSlug)` resolves a site for an admin request. A site's **slug** (admin URLs, unique per organization) and its **address** (public URLs, unique on the platform) are different values; the test factory still sets them equal. The database already refuses a duplicate address, an uppercase address, and a `domains` row whose site belongs to another organization (tested in `tests/integration/tenancy.test.ts`). `createSite` takes a context from the resolver and opens its transaction with `inTenant(ctx, …)`.*

*From M3-2 (ADR 0009): `createSite` takes `sites.create`, `deleteSite` takes `sites.delete` (Owner only), `changeSiteAddress` takes `site.settings.manage`. Order: `requirePermission` → `assertLimit` (the plan, a separate question from the role) → validate → write. Listing an organization's sites takes membership only.*

*From M3-3: `/{orgSlug}` is a small page for now (`src/app/(admin)/[orgSlug]/page.tsx`: the organization's name, the member's role, an empty "Sites" box). When `/{orgSlug}/sites` exists, turn it into the redirect plan §19 describes and add "Sites" to the shell's links. `/` (`src/app/(admin)/route.ts`) redirects to `homePath(...)`, which is `/{orgSlug}`; nothing else needs to change for it to reach the sites.*

*From M3-5 (ADR 0010): record each site change with `record(tx, …)` from `@/modules/audit`, in the transaction that makes it. Add the events to `modules/audit/events.ts` first (`site.created`, `site.deleted`, `site.address_changed`: a name, what it is about, a schema of the details, a sentence). `record` does not take a site yet: add an optional `siteId` to the entry there, checked as a UUID, when the first site-level event exists. The activity page already reads `?site=` and filters by it; add the drop-down to its filter form (`modules/audit/ui/activity-view.tsx`) once sites can be listed. An audit failure fails the change, by design.*

*From M3-5 (ADR 0004 addendum): a `<Link>` to a route handler must not be prefetched (`prefetch={false}`, or `linkPrefetch(href)` when the address is decided at run time). A prefetch runs the handler for a user who clicked nothing, and a handler can write cookies. `/` is the only such target today.*

**Depends on:** M3-2

**Acceptance criteria:**
- [x] Tables `sites`, `site_settings`, `domains` (rows of kind `subdomain` whose `hostname` holds the address label; platform class) *(from M1-1; no migration in M4-1)*
- [x] `createSite` in one transaction:
  - validates the site address (`isSiteAddress`: DNS-label shape ≤ 63; reserved words such as `www`, `app`, `api`, `admin`, `media`; uniqueness) *(trimmed and lowercased first; reserved: exactly those five; uniqueness is the table's constraint, at the insert)*
  - creates the site (`coming_soon`) + settings + `domains` row
  - checks the plan limit (`assertLimit` stub with plan in code) *(`modules/billing/plans.ts`: Free 1, Pro and trial 5; locks the organization's row, then counts)*
  - audits *(`site.created`, ADR 0010 addendum)*
- [x] `/{org}/sites` grid and `/{org}/sites/new`; `changeSiteAddress` (invalidates `host:{old}` and `host:{new}`), soft `deleteSite` *(both on `/{org}/sites/{site}/settings`; `/{org}/sites/{site}` shows the site)*

**Decisions taken here (ADR 0011):**
- **The site's slug is not asked for.** It is the address the site is created with (`acme`), or `acme-2` when an older site of the organization holds that slug, or the address is `new`. It never changes: moving a site keeps its admin URLs.
- **No list of the app's paths among reserved addresses.** An address only appears after `/s/`, so `/s/login` cannot shadow `/login`; `tests/unit/site-addresses.test.ts` proves it from the routes that exist.
- **Letters outside ASCII are refused**, not converted to punycode; a double hyphen is refused, which also refuses typed punycode.
- **A deleted site's address is free at once** (its `domains` rows are deleted, plan §11), and so is a moved site's old address. Nothing redirects from an old address.
- **Plan = `subscriptions.plan_key`; no row = Free.** A trial past its end keeps Pro limits until M11-1's job changes the row.
- **`/{orgSlug}` is now a redirect to `/{orgSlug}/sites`** (plan §19, the M3-3 note above): a route handler that looks nothing up. `/`, onboarding, the switcher, the header and every form that used to land on `/{orgSlug}` land on `/{orgSlug}/sites`. The organization nav's "Overview" is now "Sites".
- **Languages:** a list in code (`modules/sites/locale.ts`), without right-to-left ones until a theme lays them out. **Time zones:** the runtime's IANA list, UTC first; the form starts at the browser's own.

**Also delivered:**
- The activity page's site filter (the M3-5 note above).
- `SelectField` in the admin form kit, and the section nav marks the longest matching link (so "Sites" stays marked on a site's pages).
- `requireSitePage` (tenancy) for every page under `/{org}/sites/{site}`.

**Likely files/modules:** `src/modules/sites/*`, `src/modules/domains/schema.ts`, site pages

**Testing:** site address validation table; limit reached → `LimitExceeded`; isolation suite for sites.

### M4-2 · Site overview, settings and onboarding steps 2–3
**Labels:** `area:sites` `type:feature`

**Description:** Configure a site.

*From M3-3: `/onboarding` is step 1 only, and sends a user who already has an organization straight to it. Making the wizard resumable (plan §3) changes that one rule in `src/app/(admin)/onboarding/page.tsx`: an organization without a site continues at step 2 instead of leaving. After creating the organization the action redirects to `/{orgSlug}`; point it at step 2 here.*

*From M4-1 (ADR 0011): `/{org}/sites/{site}` exists as a small page (`src/app/(admin)/[orgSlug]/sites/[siteSlug]/page.tsx`: name, status, public address, language, time zone); the overview proper replaces it. `/{org}/sites/{site}/settings` exists with two sections, the site's address and deleting it: add the general, reading and analytics groups to that page, above them. The site layout (`[siteSlug]/layout.tsx`) has the site's own nav (Overview, Settings): add links there. Onboarding step 2 can render `CreateSiteForm` from `@/modules/sites` as it is; its action redirects to the new site's page, which step 3 changes. `SelectField` (`components/admin/form.tsx`) and `SITE_LANGUAGES` / `siteTimeZones()` are the language and time zone fields. The settings' JSONB groups are created empty: their readers must apply the defaults.*

*From M4-4 (ADR 0012): step 3 renders `ThemePicker` from `@/modules/sites` with `getAppearance(ctx)`'s `themes` and `theme`; its action (`chooseThemeAction`) is the same one `/…/appearance` uses. The site's nav (`siteNavItems`) already has Appearance between Overview and Settings.*

**Depends on:** M4-1, M4-4

**Acceptance criteria:**
- [x] `/{org}/sites/{site}` overview: status, primary URL, launch checklist (pages, menu, SEO, domain, publish), recent activity *(each checklist item from real rows; items whose screen does not exist yet say "Not available yet"; recent activity for those who may read the log)*
- [x] `/…/settings`: general (name, tagline, language, timezone, social links), reading (blog path, posts per page), analytics (GA4 ID, Plausible domain), with Zod-validated JSONB groups and optimistic `version` *(social links: Facebook, Instagram, X, LinkedIn, YouTube, TikTok, `https` only)*
- [x] `/onboarding` steps 2 (site) and 3 (theme) reuse the same actions *(`/onboarding/{org}` and `/onboarding/{org}/{site}`; progress derived from what exists)*

**Decisions taken here (ADR 0014):**
- **Analytics are emitted, on live sites only:** the GA4 and Plausible official snippets, through `next/script`, from IDs validated when saved and again when written (ADR 0006 §5). A coming-soon page carries none. *(Superseded by M4-5: no site emits them until consent behaviour exists; ADR 0015 §6.)*
- **Reading settings are saved and validated, and do nothing yet:** posts arrive with M5; the settings page says so, and nothing claims otherwise.
- **The audit names the fields that changed, never their values** (`site.settings_changed`).
- **One `version` for the three groups;** a save over someone else's newer one is a Conflict.
- **Onboarding progress is derived, not stored:** no organization → step 1; an organization without a site whose member may create one → step 2; otherwise done. Step 3 is optional (the site already has Studio).
- **Organization creation now goes to step 2** (`/onboarding/{orgSlug}`), as the M3-3 note above asked.

**Likely files/modules:** site pages, `src/modules/sites/{settings,validation}.ts`

**Testing:** invalid GA4 ID rejected; E2E onboarding end to end.

### M4-3 · Renderer foundation: site address/host → site, coming soon, unknown and suspended sites
**Labels:** `area:rendering` `type:feature` `risk:high`

**Description:** Serve sites by their site address (V1: `/s/{address}`) or, post-V1, by hostname, with correct caching.

*From M0-4 and ADR 0006: start from `spikes/rendering/queries.ts` (`resolveSite(locator)`) and the current `/render/[site]/[[...path]]` page; build every link from `siteBasePath()`. Keep static params for both segments, resolve the host outside `<Suspense>` (real 404s), skip the database for the build placeholder, and delete the `/dev/cache` and `/api/dev/revalidate` spike routes (ADR 0002).*

*From M4-1 (ADR 0011): every change to an address already returns `domain.changed` events (create: the new address; move: old and new; delete: the old), and the Server Actions flush them with `updateTag`. A deleted site has no `domains` rows, so resolving its old address finds nothing; keep `resolveSite` reading `domains` only, or, if it starts joining `sites`, also exclude `deleted_at is not null`. New sites are `coming_soon` and render through the spike view until this issue's coming-soon page exists. `tests/integration/sites.test.ts` calls `resolveSite` with `next/cache` stubbed: move those checks with the function.*

*From M4-4 (ADR 0012), **high priority, before public sign-ups**: `/s/{address}` still renders the M0-4 spike view (the site's name, its tagline and debug details: path, base path, cache time), for every status, and without `noindex`. Replace it here. The theme side is ready: `themeFor(site)` from `@/themes/render` takes the site's name, tagline, language, base path, `theme_key` and stored `site_settings.theme`, and returns the manifest and the context; render `<theme.Layout context>` around `theme.templates["coming-soon" | "not-found" | "page"]`. Set `robots: noindex` for coming-soon, `<html lang>` from the site's language, and import `@/themes/render` only from the site tree. Tag the render with `site:{id}` (already flushed on a theme switch) and `site:{id}:config` (settings, M8-1). `/dev/themes/{theme}/{template}` shows every template with made-up data.*

**Depends on:** M1-7, M4-1

**Acceptance criteria:**
- [x] `(sites)/render/[site]/layout.tsx` with `resolveSite(locator)` (`'use cache'`, tag `host:{address|hostname}`) → site, org, primary, status *(`resolveSite` → site, organization, `isPrimary`; the status with the rest of the public data in `loadPublicSite(orgId, siteId)`, tagged `site:{id}`, so a status change needs no address)*
- [x] Unknown site → platform "site not found"; `suspended` → "site unavailable"; `coming_soon` → theme's coming-soon page with `noindex` (preview token bypass comes in M7-4) *(both platform pages answer 404; coming soon at every path)*
- [ ] *(Host mode, post-V1)* Non-primary host → 308 to primary (except `/_forge/preview/*`) *(deferred with custom domains, M9: `resolveSite` returns `isPrimary` for it)*
- [x] Cached data functions take `siteId`/`host` as arguments; lint rule for `'use cache'` functions without a tenant argument

**Decisions taken here (ADR 0013):**
- **A suspended site answers 404, not 503.** A Next.js page cannot answer 503, and the proxy cannot know a site's status without a database lookup on every request. Its page is neutral: no name, words or theme.
- **A live site's home page** is the theme's page template with the site's name and tagline, plan Phase 4's "live placeholder"; every other path is a 404 with the theme's not-found page. Content routing is M5-6's.
- **The theme draws its own not-found page:** the layout records the site it resolved for the request, and `not-found.tsx` (which Next gives no params) reads it.
- **Removed:** `spikes/rendering/`, `/dev/cache`, `POST /api/dev/revalidate`, `tests/e2e/rendering-spike.spec.ts`, replaced by `tests/e2e/renderer.spec.ts`.

**Likely files/modules:** `src/modules/rendering/*`, `src/app/(sites)/render/[site]/*`

**Testing:** E2E via `/s/{address}` on one host; an address change invalidates the `host:` tag; the site tree never imports `modules/auth` (lint).

### M4-4 · Theme kit, Studio skeleton, theme picker
**Labels:** `area:themes` `type:feature`

**Description:** The structure every theme follows.

**Depends on:** M1-1

**Acceptance criteria:**
- [x] `src/themes/_kit`:
  - settings schema (colours, fonts, header, footer, layout) *(`tokens.ts`: strict `parseThemeSettings` for saving, lenient `readThemeSettings` for drawing)*
  - CSS-variable builder from validated values *(`themeVariables`: eleven `--forge-*` properties, applied as `style`)*
  - curated fonts via `next/font` *(ten, `next/font/google`, none preloaded; a page uses its two)*
  - base components (Container, Nav, Prose) *(plus `ThemeFrame`, which sets the theme, fonts and variables, with a skip link)*
- [x] `ThemeManifest` type + registry; Studio skeleton: layout, header/footer (one variant each), coming-soon, not-found, default page template *(header `classic`, footer `simple`)*
- [x] Theme picker (onboarding + `/…/appearance`) storing `sites.theme_key`; invalidates `site:{id}` *(`/…/appearance`; onboarding's step 3 is M4-2's and reuses `ThemePicker`)*

**Decisions taken here (ADR 0012):**
- **Journal is registered in M4-4**, following the M4-4 instructions, although this file puts the Journal theme in M8-2. It has the same skeleton as Studio (layout, a `centered` header, a `simple` footer, page, coming-soon and not-found templates, styles). Its blog templates, archives and Lighthouse work stay in M8-2.
- **A theme is a definition and a manifest.** `definition.ts` is pure data (what the admin and validation read, through `registry.ts`); `theme.ts` adds the components (what the renderer draws with, through `render.ts`). No theme component or CSS reaches the admin.
- **The registry is an allow-list.** An unknown key is refused when chosen, and drawn with Studio when stored.
- **Choosing a theme changes only `sites.theme_key`**, recorded as `site.theme_changed`, `site.settings.manage` (Owner, Admin). Settings, content and address stay byte for byte.
- **No settings write path yet.** The appearance editor (M8-1) saves through `parseThemeSettings`; M4-4 has nothing that writes `site_settings.theme`.
- **A development gallery,** `/dev/themes/{theme}/{template}`, draws every template with made-up data through the renderer's contract (`themeFor`). 404 in production, like `/dev/editor`.

**Likely files/modules:** `src/themes/*`, `src/modules/sites/appearance.*`

**Testing:** unit: token schema rejects unsafe values; the CSS builder output is only variables.

### M4-5 · Publish site (coming soon → live)
**Labels:** `area:sites` `type:feature`

**Description:** The site-level go-live switch.

*From M4-3 (ADR 0013): the renderer reads the status from `loadPublicSite(orgId, siteId)`, tagged `site:{id}`; `setSiteStatus` returns `{ type: "site.statusChanged", siteId }` and the Server Action flushes it, like `chooseTheme`. Coming soon is `noindex, nofollow` at every path; live is `index, follow` at `/` (the theme's page template with the site's name and tagline until M5-6), and every other path is a themed 404. Add a `site.status_changed` event to the audit vocabulary.*

*From M4-2 (ADR 0014): put "Publish site" on the overview (`modules/sites/ui/site-overview.tsx`), next to the status and its explanation (`STATUS_EXPLANATIONS`). The checklist's "Publish your site" item (`modules/sites/overview.ts`) is done when the status is `live`: give it the button's link. Publishing also turns on the site's analytics snippets (live sites only) and `index, follow` at `/`.*

**Depends on:** M4-3, M2-2

**Acceptance criteria:**
- [x] `setSiteStatus` (Admin+): `coming_soon` ↔ `live`; requires a verified email; audited; invalidates `site:{id}` *(`site.settings.manage`; a verified address to go live, not to go back; `site.status_changed`; the site's row locked; suspended refused)*
- [x] Overview shows the state and the live URL *(the full `APP_ORIGIN/s/{address}`; Publish and Switch to Coming soon, each with a confirmation)*

**Decisions taken here (ADR 0015):**
- **Both directions are built.** The M4-5 instructions say not to build unpublishing unless M4-5 requires it; this issue's criterion is `↔`, so "Switch to Coming soon" exists, with its own confirmation and record.
- **The event is `site.status_changed`** (M4-3's hand-off), not `site.published`: one event, `{ name, previousStatus, newStatus }`, for both directions.
- **The form names the status it wants** (not a toggle), and the site's row is locked: repeats, stale pages and concurrent requests make one change and one record.
- **Suspended sites are refused** (Conflict) in both directions; only staff lift a suspension (M12-1).
- **No analytics script runs on any site**, live or not, until a consent decision is made and built (M4-5 instructions; this reverses the M4-2 note above). IDs are still saved and validated.
- **Honest copy:** the confirmation says the live home page shows the site's name and tagline, and that pages and posts cannot be added yet.

**Likely files/modules:** `src/modules/sites/*`, overview page

**Testing:** E2E: publish site → `/s/{address}` serves real pages (after M5), and the pages are no longer `noindex`. *(Done for the live home page of M4-3; real pages are M5-6's.)*

---

## M5 — Content & editor

### M5-1 · Content schema
**Labels:** `area:content` `type:feature` `risk:high`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** The entry aggregate and terms.

**Depends on:** M3-2, M4-1

**Acceptance criteria:**
- [x] Tables `entries`, `entry_drafts`, `entry_revisions`, `terms`, `entry_terms` per plan §4.2, with composite FKs (parent, featured media placeholder column, terms) and `ON DELETE SET NULL (col)` where specified *(migrations 0001 and 0002; columns, FKs and delete rules asserted from the catalog and by behaviour)*
- [x] Unique `(site_id, locale, path) WHERE deleted_at IS NULL`; list indexes; trigram index on draft titles *(including three concurrent claims of one path: one wins)*
- [x] `entry_revisions` has no UPDATE grant *(DELETE kept for pruning; the published revision cannot be deleted)*

**Done in M5-1:** the schema was already complete, and `drizzle-kit generate` finds no difference between `src/modules/content/schema.ts` and the migrations, so there is **no new migration**. What was missing was the proof: `tests/integration/content-schema.test.ts` (real Postgres, as `forge_app` through PgBouncer) checks the columns, keys, indexes, FKs and grants; defaults and required columns; every CHECK; uniqueness at its scope, under concurrency; cross-site and cross-organization references refused (the issue's test); every delete rule; RLS on each table for the right, wrong, missing and malformed tenant context; two sites of one organization; sites and organizations trashed, suspended or removed. The isolation suite already covered the five tables (catalog, FORCE RLS, a no-WHERE read each). The issue's "services, UI" belong to M5-2 and M5-3 and were not started.

**Likely files/modules:** `src/modules/content/schema.ts`, `drizzle/*`

**Testing:** isolation suite; a cross-site parent or term is rejected by the database.

### M5-2 · Content-type registry and path/slug service
**Labels:** `area:content` `type:feature`

**Description:** Page and post definitions and URL computation.

*From M5-1: decide where the Home page's path lives before building the path builder. The plan says "Home = `/`", but `entries_path_format` (migration 0001) accepts only one or more `/segment`s, so an entry cannot be stored with the path `/`. Either the Home page keeps an ordinary path (`/home`) and `resolveRoute` serves `site_settings.homepage_entry_id` at `/` (M5-6), or a migration widens the CHECK to also allow `/` (the partial unique key then allows one Home per site and locale, and `setHomepage` must move paths). Slugs must match `^[a-z0-9]+(-[a-z0-9]+)*$` and paths their CHECK: `slugify` should produce nothing the database refuses.* **Resolved in M5-2: `/` is the Home page's stored, canonical path (migration 0005).**

**Depends on:** M5-1

**Acceptance criteria:**
- [x] `ContentTypeDefinition` interface + `page` and `post` definitions (plan §5) *(`content/types/`: definition, page, post, registry; keys checked against `entries_type_check` and the permission catalog; unknown keys find nothing)*
- [x] `slugify`, unique-slug with suffix retry on conflict, reserved path check (`/_forge`, `/sitemap.xml`, `/robots.txt`, blog path) *(`lib/slugify.ts`; `content/slugs.ts`; `content/unique-slug.ts`: `insertWithUniqueSlug`, savepoint retry on `entries_site_locale_path_unique`, at most 10 attempts, then Conflict; `content/paths.ts`: `reservedPathReason`)*
- [x] Path builder: pages from parent chain (Home = `/`), posts from the blog path *(`pagePath`, `postPath`, `parentChain`, `pathFromChain`, `wouldCreateCycle`)*

**Decisions taken here:**
- **The Home page's path is `/`, stored** (the M5-2 instructions; plan §5 "Home = `/`"). Migration 0005 widens `entries_path_format` to `path = '/' or` the old rule; nothing else changes. There is no `/home` route.
- **A free slug is chosen where the entry will live**, from what is in use there now (`base`, `base-2`, …, gaps reused, reserved paths skipped), and the insert is retried in a savepoint with the next one if a concurrent writer took it. Reading first keeps a site with many `untitled` pages from spending its attempts on known collisions; the retry is what makes it safe.
- **Slugs are at most 100 characters** (`ENTRY_SLUG_MAX`); the database has no length limit.
- **No service, action or UI:** `insertWithUniqueSlug` is a building block that runs inside M5-3's transactions after their permission check; it takes the `SiteContext`, never a site id.

**Likely files/modules:** `src/modules/content/types/*`, `src/modules/content/paths.ts`

**Testing:** unit tables for paths, slugs, reserved words, parent chains. *(Also `tests/integration/content-paths.test.ts`: `/` and migration 0005 on a fresh database and on one migrated to 0004 with content; races for `/` and for slugs.)*

### M5-3 · Entry services: create, autosave, publish transaction
**Labels:** `area:content` `type:feature` `risk:high`

**Description:** The core write paths.

*From M3-2 (ADR 0009): add `modules/content/policies.ts`. Pages have plain keys (`entries.page.update`); posts have own/any pairs, for which `canActOn(ctx, "entries.post.update", { organizationId: entry.organizationId, ownerId: entry.authorId })` is the whole policy. Reading (`entries.{type}.read`) is held by every role. Build the key from the entry's type through the content-type registry, never from request input. Register each policy in `tenantPolicyChecks` (`tests/isolation/tenant-operations.ts`). A content type added to the registry needs its keys added to the catalog: a unit test fails until the catalog's entry types and `ENTRY_TYPES` agree.*

*From M5-2: create entries with `insertWithUniqueSlug(tx, ctx, { type, locale, dir, base, blogPath }, insert)` from `@/modules/content`, inside the service's transaction and after its permission check; `dir` is `""` for a top-level page, the parent's stored path, or `/{blogPath}` for a post, and `base` is `slugFromTitle(title)` (`untitled` for a new entry). The Home page is the one entry written at `/` without it: slug `home`, path `/`, and `site_settings.homepage_entry_id` set to it; only a page may be given `/` (the CHECK allows `/` for any type; `post.routing` never produces it). A slug someone types should be refused, not suffixed, when it is not `isEntrySlug` or its path has a `reservedPathReason`. A new parent must be refused when `wouldCreateCycle` says so. `setHomepage` moves the old Home to a free top-level path and the new one to `/` in one transaction.*

*From M5-1: the database keeps references inside one site, but not everything. `entry_drafts.term_ids` is a `uuid[]` with no foreign key: check that every id is a term of the same site before saving (or publishing it into `entry_terms`, which is keyed). `entries.author_id` references `users` only: check the author is a member. Ids have no database default: insert through Drizzle (`$defaultFn` UUIDv7). Publishing must write the revision before setting `status = 'published'` with its `published_revision_id` (CHECK `entries_published_has_revision`, and `entries_published_revision_fk` requires the entry's own revision); trashing a published entry is refused (`entries_trash_not_live`), so unpublish first; restoring from the trash can hit the path key if the path was taken meanwhile (cms-architecture §6.7: "Restore re-suffixes the slug if it has been taken meanwhile").*

*From M4-1 (ADR 0011): `createSite` (`modules/sites/sites.service.ts`) creates the site, its settings, its address and its audit row in one transaction, and no Home page yet. Add the Home page draft there, in the same transaction, and set `site_settings.homepage_entry_id`, as this issue's first criterion says.*

**Depends on:** M5-2, M3-5

**Acceptance criteria:**
- [x] `createEntry` (type, title, parent/template) → entry + draft v1; Home page created automatically at site creation and set as homepage *(Home: a draft page at `/`, slug `home`, made in `createSite`'s transaction)*
- [x] `saveDraft(entryId, expectedVersion, draft)` → `Conflict` on mismatch; content validated (allow-list, size and node limits) *(the spike's document pipeline, now `modules/content/document/`)*
- [x] `publishEntry(entryId, expectedDraftVersion)` in one transaction:
  1. lock the entry
  2. idempotency check
  3. `publish` revision
  4. update the projection
  5. replace `entry_terms`
  6. audit
  7. return events
- [x] Server Actions in `content/actions.ts` flush `invalidate(events)` *(`createEntryAction`, `saveDraftAction`, `publishEntryAction`, `setHomepageAction`, through `finish`)*

**Decisions taken here (ADR 0016):**
- **`setHomepage` is built here** (the M5-3 instructions; plan §21's action list): the old Home moves to an ordinary path where it sits in the tree, the new one to `/`, and the pages below each follow, in one transaction under the settings row's lock. It takes `site.settings.manage` (the homepage is a website setting, plan §3).
- **A page's path change on publish carries to every page below it** (`moveSubtree`), in the same transaction; a taken address refuses the whole publish. Redirects from the old paths are M8-5's.
- **The draft is partial**: only the fields sent are written. Autosave is neither recorded nor flushed.
- **A typed slug is used as typed or refused** (format, 100 characters, reserved path); one that collides is refused at publish with a Conflict naming the address, never suffixed. Generated slugs (creation, the old Home's new place) are suffixed.
- **Authors**: the creator by default; crediting someone else at creation takes the type's "any" edit right, and a member of the organization. Changing the author later is M5-7's.
- **`published_at` is the entry's date**: set at the first publish, kept when it is published again.
- **Trash, unpublish and restore are M7-1's** and were not built; the safeguards they need are in its hand-off.
- New audit events `entry.created`, `entry.published`, `site.homepage_changed`; new cache event `entry.moved`.

**Likely files/modules:** `src/modules/content/{entry,publishing}.service.ts`, repositories, actions

**Testing:** integration: atomicity (a failure mid-transaction leaves no partial state), idempotent retry, version conflict, concurrent publish serialised.

### M5-4 · Editor shell, text nodes, autosave and conflicts
**Labels:** `area:editor` `type:feature` `risk:high`

**Description:** The Tiptap editor per ADR 0003.

*From M5-3 (ADR 0016): save through `saveDraftAction(orgSlug, siteSlug, entryId)` with two fields: `version` (the draft version the editor started from) and `draft` (JSON: only the fields that changed, e.g. `{ title, content }`). Success returns `values.version` (the new one); a mismatch is a Conflict (`DRAFT_CHANGED`) and writes nothing. The document is checked by `parseDocument` from `@/modules/content/shared`: run it in the browser before saving, and move the per-node attribute schemas from `modules/content/document/schema.ts` into the block registry without changing the rules. New entries start with `emptyDocument()` (one empty paragraph). Publish with `publishEntryAction(…, entryId)` and `version`; the same version twice answers "Already published."; a newer save is a Conflict (`NEWER_SAVE`).*

*From M0-5: start from `spikes/editor/`. Carry over the paste guard, the columns normalizer and the client-only (`ssr: false`) loading. Add client-side id dedupe before save (ADR 0003, gap 3).*

**Depends on:** M0-5, M5-3

**Acceptance criteria:**
- [x] Editor route `/…/pages/[entryId]` and `/…/posts/[entryId]` (lazy-loaded bundle) *(`EntryEditorPage`; `next/dynamic` with `ssr: false`; other sites', other types' and trashed entries are the 404 page)*
- [x] Nodes: heading (2–4), paragraph, bullet/ordered list, blockquote, divider; marks: bold, italic, underline, strike, code, link (with an entry picker from `/api/app/entries/search`) *(`src/blocks/text-nodes/`; links stored as `entry:{id}`)*
- [x] Slash menu, stable IDs, allow-listed paste normalisation *(UUIDv7 ids, deduped before saving; pasted h1 → h2, h5/h6 → h4)*
- [x] Autosave (2 s debounce, 30 s max) with status indicator; local buffer per entry + version; conflict dialog *(the dialog offers "Load the latest version" and "Copy my changes"; overwrite is M7-3's, see below)*
- [x] Title field; publish button (basic publish)

**Decisions taken here (ADR 0003, addendum M5-4):**
- **The conflict dialog has two of plan §6.3's three choices.** "Overwrite (the other version saved as a revision first)" needs `save` revisions (M7-3) and is added there. *(Done in M7-3, ADR 0026 §4.)*
- **A document with blocks this editor lacks is not opened for editing** (nothing can be lost by saving it). It goes away when M5-5 and M6 add those blocks.
- **Autosave does not re-render the page** (`FormOutcome.refresh: false`).
- **The site overview links to the Home page's editor**, so the editor is reachable before M5-7's lists. A site made before M5-3 shows "This site has no home page yet."; giving it one is M5-7's (below). No data was backfilled.
- **Every member can open an editor; only those the policies allow can change or publish** (read-only otherwise).

**Likely files/modules:** `src/modules/content/editor/*`, `src/blocks/{text-nodes}/*`

**Testing:** E2E type → reload → content persists; conflict between two tabs shows the dialog; paste of malicious HTML yields safe nodes.

### M5-5 · Custom blocks, properties panel, reordering
**Labels:** `area:editor` `type:feature`

**Description:** The structural blocks.

*From M5-4 (ADR 0003 addendum): the editor's schema is `src/blocks/text-nodes/extensions.ts` plus whatever the block registry adds; `TEXT_NODE_TYPES` is the list of what the editor can hold, and a stored document with any other node is not opened for editing (`data-testid="unsupported-blocks"`): widen that list as blocks are added, then delete the spike (`spikes/editor/`, `/dev/editor`, `tests/e2e/editor-spike.spec.ts`) once its custom nodes, NodeViews, drag handle and `PasteGuard` have moved. The slash menu's commands are `SLASH_COMMANDS` in `modules/content/editor/slash.ts`: add the blocks there. The document's per-node attribute schemas are still in `modules/content/document/schema.ts`.*

*From M0-5: button, columns, embed and spacer already exist in `spikes/editor/`. Decided 2026-10-01 (plan §6.1, §6.3):*
- *Embeds: YouTube and Vimeo, plus a `generic` https iframe URL only after URL-safety validation (`platform/net/url-safety` must exist first). No provider-specific integrations.*
- *Top-level drag snaps to the gaps between top-level blocks, with a visible insertion gap. Drops into containers keep ProseMirror's behaviour.*
- *From M3-5's verification (ADR 0003, discovery 11): block moves less than half a second apart are one undo step today, because ProseMirror's history groups them. Decide here whether each Alt+↑/↓ is its own undo step (`closeHistory(tr)`), and test the choice with moves both quicker and slower than the grouping delay.*

**Depends on:** M5-4

**Acceptance criteria:**
- [x] Block registry entries (`schema`, Tiptap extension, NodeView, render) for `button`, `columns`/`column` (2–3, no nesting), `embed` (YouTube, Vimeo with privacy URLs; `generic` iframe URL after URL-safety validation), `spacer` *(`src/blocks/{button,columns,embed,spacer}/`, assembled by `schemas.ts`, `editor.ts`, `render.tsx`; `platform/net/url-safety.ts`; the renderers are wired to public pages in M5-6)*
- [x] Properties side panel generated from each block's Zod schema *(`modules/content/editor/panel/`: `fieldsOf` reads the schema and its `.meta()` hints; a change is applied only when the whole block is valid)*
- [x] Drag handle reorder + Alt+↑/↓ + block menu (move, duplicate, delete) *(drag snaps to the gaps between top-level blocks; each Alt move is its own undo step; the block menu is on the handle and on the toolbar)*
- [x] `v` attribute + `migrate` scaffold per custom block *(`v: 1` and an empty `migrate` table each; the document pipeline runs them, tested with a v3 fixture)*

**Decisions taken here (ADR 0003, addendum M5-5):**
- **One registry, one definition per block.** The document's validation, the editor and the renderers read the same schemas. The spike is deleted; its tests were ported.
- **Each Alt+↑/↓ is its own undo step**, and typing straight after a move is a step of its own.
- **Embeds are made from an address**, asked for in a dialog and checked before anything is inserted. The provider follows the address. The server also blocks generic embeds of Forge's own host.
- **Images and `entry:` links are checked on the server.** New ones on save must be this site's (media ready and not deleted; entries not trashed); none may be another site's on publish.
- **The image block's schema is in the registry** (`editable: false`); everything else about it is M6-4's (below). A document with an image is still not opened for editing.
- **Autosave no longer saves transactions that change nothing stored** (the trailing paragraph after a final block, a click), which had made a new version, and a false conflict for another tab, on merely opening such a page.

**Likely files/modules:** `src/blocks/{button,columns,embed,spacer}/*`, `src/modules/content/editor/panel/*`

**Testing:** unit: schema validation and migrate; E2E build a two-column section with a button and reorder it. ✔ unit: `src/blocks/{schemas,render}.test.ts(x)`, `platform/net/url-safety.test.ts`, `modules/content/document/{registry,references}.test.ts`, `modules/content/editor/{blocks,editor,text-nodes}.test.ts`, `panel/properties-panel.test.tsx`, `content/references.test.ts`; integration: `tests/integration/content-blocks.test.ts`; E2E: `tests/e2e/editor.spec.ts` (the two-column section with a button, reordered by keyboard, block menu and drag; a video; a phone; read-only; opening saves nothing).

### M5-6 · Closed renderer, theme templates, public routing
**Labels:** `area:rendering` `type:feature` `risk:high`

**Description:** Render published content on sites.

*From M5-5 (ADR 0003 addendum): the custom blocks' renderers are `BLOCK_RENDERERS` in `src/blocks/render.tsx`: `({ attrs, children, context })`, each validating its own attributes and returning `null` when they are invalid. Build the whole-document renderer around them: the text nodes and marks, `columns` given each rendered column as one entry of `children`, and unknown nodes skipped. Give it a `BlockRenderContext`: `resolveEntryHref(entryId)` (live paths only; a page in the trash or unpublished gives `undefined`, and the button then renders nothing) and `blockedHosts` (the app's own host, as `modules/content/references.ts` uses). The spike's whole-document renderer and its 31-payload XSS corpus are in git (`spikes/editor/render.tsx`, `render.test.tsx` at `e55a37d`): port the corpus. The blocks emit `forge-button*`, `forge-columns`/`forge-column` (grid template from the ratio; `--stack` on phones), `forge-embed--{aspect}` and `forge-spacer--{size}` classes: style them in the theme kit. The image's renderer is M6-4's.*

*From M5-3 (ADR 0016): published entries have `status = 'published'`, their live fields on `entries` and the content in the revision `published_revision_id` names. The Home page is the entry at `/` (and `site_settings.homepage_entry_id`), and it is a draft until someone publishes it: until then, render the site's current home. `entry.moved` (a live path changed without a publish) flushes the entry, `routes` and `config`. A change of the blog path in the reading settings does not move existing posts: their stored paths keep the old blog path; decide here (or in M8-5) whether saving the reading settings moves them.*

*From M4-4 (ADR 0012): add the new templates to `TEMPLATE_KEYS` and `TemplateProps` in `src/themes/types.ts`; the types then require them of every theme. Studio's and Journal's `page` template take the page's `title` and its content as `children`, inside `Prose`. Block renderers go in `src/themes/_kit/blocks/`, drawn with the kit's variables.*

*From M4-5 (ADR 0015): the Publish dialog (`modules/sites/ui/site-publishing.tsx`) tells the customer that the live home page "shows its name and tagline in its theme. Adding pages and posts is not available yet", and `STATUS_EXPLANATIONS.live` says visitors see "its home page". Once a live site serves real pages, update both, and `tests/e2e/publishing.spec.ts`'s expectations.*

*From M5-2: the Home page is stored at path `/` (migration 0005), so `/` resolves with the same `(site_id, locale, path)` lookup as every other page; `site_settings.homepage_entry_id` names the same entry. Paths come from `contentType(type).routing(…)` and `pathFromChain` in `@/modules/content`.*

*From M4-3 (ADR 0013): replace the `home` / `page-not-found` decision for live sites in `modules/rendering/render-state.ts` with `resolveRoute(siteId, path)`, keeping coming soon and unavailable as they are. The page (`app/(sites)/render/[site]/[[...path]]/page.tsx`) calls `notFound()` for a missing route; `not-found.tsx` already draws the theme's not-found template from `requestSite()`. Cached reads must take `siteId` (lint).*

*From M4-2 (ADR 0014): the reading settings exist: `readReading(site_settings.reading)` → `{ blogPath, postsPerPage }` (defaults `blog`, 10). `resolveRoute` takes the blog's path from there. The overview's checklist counts published pages already (`launchCounts`): give its "Add your pages" item the pages screen's link.* *(M5-6: done for the blog's path; the pages screen is M5-7's, so the checklist link moved there.)*

**Depends on:** M5-3, M4-3, M4-4

**Acceptance criteria:**
- [x] Closed node → React renderer (no `dangerouslySetInnerHTML`); `entry:{id}` links resolved to live paths; unknown nodes skipped *(`modules/rendering/document.tsx`: every node checked again against the registry; skips reported and logged once per cache fill; the image skipped until M6-4)*
- [x] `resolveRoute` (cached): homepage, pages by path, blog index, post, category/tag archives, pagination, 404 *(`modules/rendering/{routes,content}.ts`; exact stored paths only; `/` without a published Home page shows the site's name and tagline)*
- [x] Studio templates: page (default, full-width, landing), post, blog index, term archive *(Journal: its page templates, and the kit's post, blog index and archive until M8-2; block styles in `_kit/blocks.css`)*
- [x] Cache tags `routes`, `entry`, `list:{type}` applied; publish invalidation verified *(plus `site:{id}` on every read; no event changed)*

**Decisions taken here (ADR 0017):**
- **The public read rule** (published, not in the trash, this site and language, content from the published revision) lives in `modules/rendering`.
- **One spelling per address:** exact stored paths, `…/page/1` and other spellings are 404s; no redirects (M8-5).
- **A blog path change** moves the index and archives; posts stay at the path they were published at until published again (M5-3's open question).
- **Generic embeds may submit forms** (`allow-forms`): forms and booking widgets are the approved generic use. Videos get the media `allow` list instead.
- **The Publish dialog and the live status text** now say visitors see the published pages and posts (M4-5's hand-off).

**Likely files/modules:** `src/modules/rendering/*`, `src/themes/studio/templates/*`, `src/themes/_kit/blocks/*`

**Testing:** renderer XSS corpus; E2E publish → visible; edit + republish → updated without purge. ✔ unit: `modules/rendering/{document,routes}.test.ts(x)` (the spike's 31 payloads and 21 more), `ui/public-page.test.tsx`, `themes/themes.test.tsx`; integration: `tests/integration/public-content.test.ts` (draft privacy, isolation, lists, links, and each operation's tags against each read's); E2E: `tests/e2e/public-content.spec.ts` (a site's pages, posts, blog, archives and blocks; 404s for drafts, the trash and other sites; a hostile document; a phone; publish → visible, draft private, republish → updated, Coming soon ↔ live and a theme switch, made in the admin).

### M5-7 · Pages and posts admin: lists, new forms, entry sidebar
**Labels:** `area:content` `type:feature`

**Description:** Everything around the editor.

*From M5-6 (ADR 0017): a page's template is `entry_drafts.template`, published with it: `default` (or null), `full-width`, `landing` (`PAGE_TEMPLATES` in `src/themes/types.ts`); the sidebar offers those three. A live site without a published Home page shows its name and tagline at `/`, so "Set as homepage" and publishing it are what change the public home. From M4-2: give the overview checklist's "Add your pages" item the pages screen's link.*

*From M5-4: the editor is at `entryEditorPath(orgSlug, siteSlug, type, id)` from `@/modules/content/shared`; the lists and "new" forms link and redirect there. **Sites made before M5-3 have no Home page** (the overview says so): give the Owner and Admin a way to make one, i.e. create a page and "Set as homepage" (`setHomepageAction`), and decide whether existing production sites need a one-off backfill before public launch (none was done: no destructive or implicit bulk change).*

*From M5-3 (ADR 0016): the new forms post to `createEntryAction(orgSlug, siteSlug, type)` with `title`, `parentId`, `template`, `authorId` (success: `values.entryId`); "Set as homepage" to `setHomepageAction(…, entryId)` (Owner, Admin). Not built yet, and the sidebar needs: changing an existing entry's author (check membership as `createEntry` does: `isMember`), and moving a page (`parent_id`): refuse it when `wouldCreateCycle` says so, require a page of the same site, and carry the path change with `moveSubtree` in the same transaction. A typed slug that collides with another entry is refused at publish; an early hint at save would be a read-only check.*

**Depends on:** M5-4

**Acceptance criteria:**
- [x] `/…/pages`: tree list (drag to reorder siblings; set parent), search, status filter *(`placePage` and `movePage` in `tree.service.ts`; Move up/down and Move under… for the keyboard)*
- [x] `/…/posts`: list with filters (status, category, author), search, sort *(25 a page, by page number)*
- [x] `/…/pages/new`, `/…/posts/new` forms (title + parent/template) → action → redirect to the editor *(and the author for Owner–Editor; "Make it the home page" for Owner and Admin)*
- [x] Editor sidebar: slug, parent, template, excerpt, author (Editor+), categories/tags, featured image slot (wired in M6-4); "Set as homepage" *(categories and tags: the site's existing terms; creating them is M5-8's)*
- [x] Authors see and edit only their own posts; pages hidden from Authors *(`ownPostsOnly`: lists, editor, link picker; the permission catalog is unchanged)*

**Decisions taken here (ADR 0018):**
- **What an Author sees** is decided from permissions (`ownPostsOnly`), not from a role: their own posts, no pages, the link picker limited to public entries and their own.
- **Moving a page is immediate**, with the pages below, in one transaction, serialized per site with homepage changes; `entry.moved` and `entry.reordered` are recorded. Redirects stay M8-5's.
- **Changing the author** is Owner–Editor, members only, immediate (`entry.author_changed`).
- **The sidebar's draft fields** are saved by autosave, only once changed, and a slug only once valid; its immediate actions do not re-render the editor's page.
- **Sites without a Home page** get a "Create the home page" path for Owners and Admins; no backfill ran. A pre-launch backfill is M12-2's (below).
- **Overlap with M5-8:** assigning existing terms in the sidebar is built here; creating and managing terms remain M5-8's.

**Likely files/modules:** page/post routes, `src/modules/content/queries.ts`, `ui/*`

**Testing:** E2E Author permissions; list filters. ✔ integration: `tests/integration/content-admin.test.ts` (lists, scoping, an Author's view, forms, moves with their refusals and concurrency, ordering, authors, role matrix); unit: `content/list-query.test.ts`, `sites/overview.test.ts`, `audit/events.test.ts`; E2E: `tests/e2e/content-admin.spec.ts`.

### M5-8 · Categories and tags
**Labels:** `area:content` `type:feature`

**Description:** Taxonomy management and assignment.

*From M5-7 (ADR 0018): the editor's sidebar already lists the site's existing categories and tags as checkboxes and saves them with the draft (`entry-settings.tsx`), and the posts list filters by a draft's category. What is left of assignment: creating a tag (or a category) from the sidebar, for Authors too (criterion 3). Add the term screens to the site's nav next to Posts (`siteNavItems`).*

*From M5-6 (ADR 0017): the public site reads terms in three cached places: `resolveRoute` (an archive's term, tag `site:{id}:routes`), `loadPostList` (an archive's posts, `site:{id}:list:post`), and `loadEntry` (a post's term names and slugs, `site:{id}:entry:{eid}`). Creating, renaming, re-slugging or deleting a term must return a cache event that flushes the routes and `list:post` at once, and either the entries of the posts that carry it or, more simply, the site umbrella; add that event to `platform/cache/events.ts`.*

*From M5-3 (ADR 0016): `saveDraft` already writes `entry_drafts.term_ids` (with `terms.assign`), and checks each id is a term of the same site in a taxonomy the type uses; `publishEntry` checks them again and replaces `entry_terms`. Deleting a term removes its `entry_terms` (CASCADE) but not its id from drafts' `term_ids`: remove it there too, or the next publish of such a draft is refused.*

**Depends on:** M5-3

**Acceptance criteria:**
- [x] `/…/posts/categories` (hierarchical, one level of nesting) and `/…/posts/tags`: create, rename (slug change → archive redirect in M8-5), delete (shows usage count) *(`term.service.ts`; the delete dialog names the published posts and drafts it takes the term off; renamed slugs get no redirect yet)*
- [x] Assignment in the editor sidebar writes `entry_drafts.term_ids`; `entry_terms` replaced on publish *(since M5-7; a deleted term is now taken out of drafts in the delete's transaction)*
- [x] Authors can assign existing terms and create tags *("Add a tag" in a post's settings: `terms.assign`; categories stay `terms.manage`)*

**Decisions taken here (ADR 0019):**
- **Deleting a term** locks the drafts that hold it, takes it out of them, removes its post links (CASCADE) and moves its subcategories to the top level, in one transaction with `term.deleted`. Save, publish and delete lock drafts before terms, so a race ends with the reference cleaned or the save refused, never stale. Draft versions are not moved.
- **`term.changed`** (new in `platform/cache/events.ts`) flushes the routes and each post carrying the term at once (the site past 200 posts), and the post lists stale-while-revalidate.
- **Slugs:** made from the name with a suffix when taken (retried under concurrency); a typed slug is used or refused, never suffixed.

**Likely files/modules:** `src/modules/content/{term.service,term.repository}.ts`, term pages

**Testing:** a draft term change doesn't alter the live archive until publish; isolation. ✔ integration: `tests/integration/content-terms.test.ts` (both, and creating, renaming, nesting, deleting with its races and rollback, permissions, freshness by each operation); unit: `platform/cache/cache.test.ts`, `content/term-validation.test.ts`, `audit/events.test.ts`; E2E: `tests/e2e/content-terms.spec.ts`.

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
- [x] Tables `media_folders`, `media_assets` *(since M1-1; M6-1 adds two partial indexes, migration 0006, and the cleanup's lookup function, 0007)*
- [x] `requestUploads(files)`: type and size checks, storage limit check, `pending` rows, presigned PUTs (10 min) *(`modules/media/upload.service.ts`, `requestUploadsAction`; JPEG/PNG/WebP/GIF ≤ 20 MB, PDF ≤ 25 MB; all or nothing; Free 1 GB, Pro 20 GB under the organization lock; targets signed for type and size, create once)*
- [x] `completeUpload(mediaId)`: HEAD size match, magic-byte sniff, mismatch → delete + `failed` *(the uploader's own upload only; stored type checked too; `ready` recorded as `media.uploaded`)*
- [x] `uploads.cleanup` daily job for `pending` rows older than 24 h *(`modules/media/cleanup.ts`, in `DAILY_JOBS`; refused rows go too; objects deleted through each row's own scope)*

**Decisions taken here (ADR 0020; ADR 0008 addendum):**
- **Server Actions**, as the plan lists them; no UI (the dropzone is M6-3's). The `/api/dev/storage` route is deleted.
- **Completion checks what storage holds:** the size, the stored type and the first 4 KB must be the declared type's. A mislabelled file (a JPEG named `.png`) is refused with what it is.
- **Storage reserved at request:** pending, ready and trashed uploads count; failed ones give their bytes back. Five concurrent requests for the last room: exactly one wins.
- **Upload targets create their object once** (`If-None-Match: *` signed; the local route never overwrites): a retry or a reused link cannot replace a checked file.
- **Content may point only at a ready image of its site:** image blocks now also require `kind = 'image'`, and a new featured image gets the same check in `saveDraft`.
- **Provisional numbers recorded as open:** 20 files a request, 255-character names, binary MB/GB.

**Likely files/modules:** `src/modules/media/*`

**Testing:** integration against MinIO: happy path, spoofed type, oversize, quota race. ✔ integration against RustFS and the local driver: `tests/integration/media-uploads.test.ts` (all four, and mislabelled types, create-once targets, early completion, size mismatch, concurrent completions, storage and database failures, audit rollback, the cleanup and its race with a completion, roles, uploader-only, other sites and organizations, content attachment); `isolation.test.ts`, `rls.test.ts` (the lookup), `audit.test.ts`, `storage.test.ts`; unit `media/policy.test.ts`, `billing/plans.test.ts`; E2E `storage.spec.ts`, `cron.spec.ts`. Real Cloudflare R2: not verified (runbook §4).

### M6-2 · Image processing and CDN delivery
**Labels:** `area:media` `type:feature`

**Description:** Synchronous variants and fast delivery.

*From M6-1 (ADR 0020):*
- *`completeUpload` (`modules/media/upload.service.ts`) checks the object and then settles the row `pending → ready` with `media.uploaded`, in one transaction. Run `processImage` between the checks and that transaction, outside it (storage I/O).*
- *A failure that is the file's fault (too many megapixels, undecodable): settle it `failed` and delete the object, as the sniff mismatch does. A failure that is ours (storage down): leave it `pending`, so a retry works.*
- *Variants' keys: `mediaObjectKey({ …, variant: "w800" })` under the same media id. Delete them wherever the original is deleted: the cleanup (`modules/media/cleanup.ts`) deletes only `storage_key` today.*
- *Decide whether variants count towards the storage limit. `billing/limits.ts` sums `size_bytes` of the originals.*
- *`/media/{key}` must serve only the objects of `ready`, untrashed rows. A pending upload's object exists before it is checked, and a refused one's may linger until the cleanup. Look the key up rather than streaming any key that exists.*
- *Next queues a page's Server Actions, so completions run one after another. If processing makes that slow for many files, a route handler with an origin check is the alternative (ADR 0020, "Reconsider").*

*From M2-4: the account avatar moved here. It is a user-level image (no organization): store it through `platformStorage()` under a user prefix (e.g. `u/{userId}/…`), run it through `processImage` (square thumb, metadata stripped), serve it from `/media/{key}`, and set `users.image` to that URL. `/update-user` currently accepts the name only (`EDITABLE_PROFILE_FIELDS` in `modules/auth/auth.ts`): set the image on the server from the upload, never from a URL the browser sends. The account page (`src/app/(admin)/account/page.tsx`) and `AccountMenu` show initials until then; a Google account may carry Google's picture URL in `users.image`, which is not displayed.*

**Depends on:** M6-1

**Acceptance criteria:**
- [x] `processImage(mediaId)` inside `completeUpload`: `sharp` with `limitInputPixels`, auto-rotate, metadata stripped; widths 400 (square thumb), 800, 1600, 2400 (≤ original) as WebP → `variants` JSONB *(`modules/media/processing.ts`; 50 MP checked from the header; animations stay animated; under 800 wide: its own width; variants named on the row before they are written; their bytes in `variant_bytes`)*
- [x] Route `maxDuration`/memory configured; p95 processing time logged *(`/account` exports `maxDuration = 60`; Hobby's memory is fixed at 2 GB, so one decode is bounded by the pixel limit and sharp's cache is off; each duration is logged with the instance's p95 of its last 50)*
- [x] Account avatar on `/account`: upload via the storage driver, processed and served like other media *(moved from M2-4)* *(a presigned PUT under `u/{user}/`, checked, a 400 square, `users.image` set by the server; every object tracked by `avatars.collect`)*
- [x] V1 delivery at `/media/{key}` (ADR 0006): a route handler streams the object from storage with `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and only allow-listed MIME types (never HTML/JS/SVG); unknown keys → 404. A CDN domain is post-V1 via `MEDIA_PUBLIC_BASE_URL` *(only through a record: ready, untrashed variants and documents, current avatars; image originals never; 404s `no-store`; the proxy's own `media` surface strips credentials)*
- [x] A `<ResponsiveImage>` kit component produces `srcset`/`sizes`/`width`/`height` *(`src/themes/_kit/components/responsive-image.tsx`, with `responsiveSources` in `@/modules/media/shared`)*

**Decisions taken here (ADR 0021):**
- **Variants count towards the storage limit:** their real bytes are checked in the transaction that makes the upload ready. Over the limit: refused, and everything given back.
- **One completion processes an upload at a time:** a 15-minute hold (longer than any function's run). A second completion waits, or takes over a dead one's leftovers. Nothing is ever `ready` until every variant is stored.
- **An image's original is never served** (its EXIF and GPS are still in it).
- **The account avatar** has no media row and no quota. Delayed `avatars.collect` jobs delete every object that is not the user's picture.

**Likely files/modules:** `src/modules/media/processing.ts`, `src/app/media/[...key]/route.ts`, `src/themes/_kit/components/ResponsiveImage.tsx`

**Testing:** integration: EXIF GPS absent in variants; a 60 MP image rejected; srcset output snapshot. ✔ The three:
- integration with both drivers (local and RustFS): `media-processing.test.ts` (21), `media-delivery.test.ts` (12), `avatar-upload.test.ts` (12), plus RLS (the delivery lookup) and isolation;
- unit: `media/processing.test.ts`, `_kit/components/responsive-image.test.tsx` (the exact srcset output);
- E2E: `media.spec.ts` (the avatar in a browser; `/media` headers and 404s).

Real Cloudflare R2, Vercel's CDN, and function limits on Vercel: not verified (no deployment).

### M6-3 · Media library UI
**Labels:** `area:media` `type:feature`

**Description:** Manage media.

*From M6-2 (ADR 0021):*
- *Completing an image now processes it, typically in 1–3 s. Export `maxDuration = 60` from every page whose actions complete uploads (as `/account` does).*
- *`completeUploadAction` answers:*
  - *a ready item with `width`, `height` and `storedBytes`;*
  - *`LimitExceeded` when its variants do not fit (the file is gone);*
  - *`Conflict` "still being finished" when another completion of it is running.*
- *The library's thumbnails: the `thumb` variant's URL (`publicUrl(variant.storageKey)`), never the original (`/media` does not serve an image's original).*
- *Showing storage used: `allowanceOf(tx, org, "storage")` counts originals and variants.*
- *A trashed item's URLs stop working at once (`/media` checks the record). A CDN may still hold a copy it cached before, as it was immutable.*

*From M6-1 (ADR 0020): the dropzone calls `requestUploadsAction(orgSlug, siteSlug, files)` with up to 20 `{ name, size, type }`. It then PUTs each file to its `upload.url` with exactly `upload.headers` (they include `if-none-match: *`). Use XHR for progress (fetch has no upload progress). Then it calls `completeUploadAction(orgSlug, siteSlug, mediaId)` per file.*
- *Answers:*
  - *`Conflict`: the file has not arrived. Send it again within the 10 minutes, then complete again.*
  - *`Validation` with a message: the file was refused. It is gone; show the message.*
  - *`LimitExceeded`: the plan's storage.*
- *`checkFile` and `UPLOAD_TYPES` in `@/modules/media/shared` let the dropzone warn before asking. The server decides anyway.*
- *A request is all or nothing. Leave refused files out and ask again.*
- *Folders: `requestUploads` puts files in no folder; add the folder there (a folder of the same site: the composite key).*
- *Authors' own uploads: `uploaded_by`. A NULL uploader is nobody's own (only `.any`).*
- *The open numbers to settle with the screen: 20 files a request, 255-character names, re-issuing a target for a pending upload (not offered).*

**Depends on:** M6-2

**Acceptance criteria:**
- [x] `/…/media`: dropzone multi-upload with per-file progress and retry *(`ui/upload-dropzone.tsx` over `ui/upload-queue.ts`: requests of at most 20, XHR progress, per-file states and reasons, retries only as the upload's state allows; folder on upload; `maxDuration = 60`)*
- [x] Grid and list views; folder sidebar (one level): create, rename, delete-empty, move *(move: from the drawer, or several selected at once; folders are Editors')*
- [x] Trigram search over title/filename/alt; filter by kind and folder; sort by newest, name, size
- [x] Detail drawer: edit title, alt, caption; copy URL; trash/restore; `trash.purge` removes objects after 30 days *(the URL is an image's widest variant, never its original; `trash.purge` is daily, media now, entries in M7-1)*
- [x] Authors manage their own uploads only *(`media.update`/`media.delete` own/any; Authors see the library, others' files read-only)*

**Decisions taken here (ADR 0022; ADR 0020 addendum):**
- **The upload policy, settled:**
  - 20 files a request; a larger selection is sent in independent requests;
  - names up to 255 characters, refused beyond, never cut;
  - binary units, shown as KiB, MiB and GiB;
  - a mislabelled file refused, not relabelled;
  - a PDF's `%PDF-` at byte zero.
- **Retries** use only the current contract. An expired link means a new upload, and its earlier reservation lasts until `uploads.cleanup`. Renewing or cancelling a pending upload is a recorded server gap.
- **The listing** shows only ready files of this site. Thumbnails are the `thumb` variant.
- **Trash and restore** flush `media:{mid}` at once (new cache events). Details flush it stale.
- **`trash.purge`** claims a file as `failed` before deleting its objects, so a concurrent restore can never win.
- **Seven audit events** for files and folders.

**Likely files/modules:** media page, `src/modules/media/ui/*`, `src/app/api/app/media/*`

**Testing:** E2E upload 3 images + 1 PDF, search, move to a folder, trash and restore. ✔
- E2E: `tests/e2e/media-library.spec.ts`, that flow and three more (folder on upload with refusals and a retried send; an Author and a Viewer; a phone with the keyboard).
- Integration: `media-library.test.ts` (17), isolation, RLS, audit.
- Unit: `upload-queue.test.ts`, the policy's boundaries.

Deployment checks (R2 CORS, CDN, timings, PDF in browsers): runbook §4 step 6, not yet run.

### M6-4 · Media picker, image block, featured/OG/logo/favicon
**Labels:** `area:media` `area:editor` `type:feature`

**Description:** Use media everywhere.

*From M5-5 (ADR 0003 addendum): the image block's schema is already in the registry (`src/blocks/image/schema.ts`: `mediaId`, `alt`, `caption`, `size`, `link`; `editable: false`). Stored documents with images are validated, and the server checks every new `mediaId` on save (a media item of this site, `ready`, not deleted) and refuses another site's on publish (`modules/content/references.ts`). What is left here:*
- *An `extension.ts`, a `node-view.tsx` and a `render.tsx` (with `ResponsiveImage`) for it. Add it to `BLOCK_EDITORS` in `src/blocks/editor.ts` and `BLOCK_RENDERERS`, and set `editable: true`. `EDITOR_NODE_TYPES` then includes `image`, and pages with images open in the editor (`tests/e2e/editor.spec.ts` "a page holding blocks this editor cannot edit yet" changes with it).*
- *Inserting one: a slash-menu entry that `asks` for a media item (like the embed's `asks: "address"`) and opens the picker, so an image is never inserted without a `mediaId`. Its alt, caption, size and link come from the properties panel, which already generates fields from the schema.*
- *`references.ts` reads `media_assets` directly because the media module has no service yet. Move that check behind the media module's API when it exists. From M6-1: it is `assertUsableImages` now (this site, `ready`, not trashed, `kind = 'image'`), used for images in documents and for a new featured image in `saveDraft`. A PDF is a media item but never an image.*
- *No upload path was added in M5-5. Images reach a document only through the picker and the existing upload protocol (M6-1).*
- *From M6-3 (ADR 0022):*
  - *The picker reuses `listLibrary(ctx, query)` (only ready, untrashed files of the site; search, kind, folder, sort, pages of 48), `LibraryItem` (`thumbUrl`, `url`, `width`, `height`, `altText`), and the dropzone (`UploadDropzone`, with a folder) for "library + upload".*
  - *`/api/app/media` (picker JSON) is not built; M6-3 needed none.*
  - *Tag the public reads with `media:{mid}` for each image drawn: trashing and restoring now flush it at once (`media.trashed`, `media.restored`), and details stale (`media.updated`).*
  - *Alt text lives on the item (`alt_text`); the block's `alt` overrides it.*
- *From M6-2 (ADR 0021):*
  - *`<ResponsiveImage>` is `src/themes/_kit/components/responsive-image.tsx`. Feed it `responsiveSources(item.variants, publicUrl)` (`@/modules/media/shared`) and the item's `width`, `height` and alt text.*
  - *An image's original is never served, so a link to the "full size" is the largest variant.*
  - *GIF and WebP animations stay animated in their variants.*
  - *Logo and favicon sizes need presets of their own: `planVariants` has `media` and `avatar` today.*
  - *PDFs are served inline under `Content-Security-Policy: sandbox`. Check in a real browser that its PDF viewer displays them; Chrome's may refuse a sandboxed document, and then the PDF downloads.*
- *From M5-7 (ADR 0018): the post sidebar has a featured-image slot (`data-testid="featured-image"` in `modules/content/editor/entry-settings.tsx`) that says it arrives with the media library. Wire the picker there, sending `featuredMediaId` with the draft fields (saveDraft already checks it against the site).*
- *From M5-6 (ADR 0017): the public renderer skips `image` and reports it (`NOT_RENDERED_YET` in `modules/rendering/document.tsx`). Add the image's renderer to `BLOCK_RENDERERS` (its media resolved through the render context, never a stored URL), remove it from `NOT_RENDERED_YET`, tag `loadEntry` with each media item's `media:{mid}` it draws (plan §20, capped), and add `figure`/`img` cases to the XSS corpus. `RENDERED_ELEMENTS` already lists `figure` and `figcaption`.*

**Depends on:** M6-3, M5-5

**Acceptance criteria:**
- [x] Picker modal (library + upload) reused across the admin *(ADR 0023 §1: `MediaPicker` over `GET /api/app/media` (`listLibrary`, images only), its upload the M6-3 dropzone; used by the image block, its panel, the featured image, the logo and the favicon)*
- [x] `image` block (`mediaId`, alt override, caption, size, link) rendered with `ResponsiveImage`; missing or trashed media renders nothing *(§2–3: the registry's block, inserted from the slash menu through the picker; `srcset` from its `w{n}` variants only; every image drawn tagged `media:{id}`, so trash and restore show on the next request)*
- [x] Featured image on posts; OG image field (SEO, M8-4); logo and favicon in site settings (favicon sizes generated) *(§4–7: featured image through the draft and publish; logo and favicon with variants made at upload (logo inside 640 × 240, favicons 32 and 180 PNG); the OG image field is M8-4's, as the criterion says: the picker and checks it needs are ready, nothing SEO is built)*
- [x] Composite FK prevents using another site's media *(§10: tested by constraint name for drafts, entries, logo and favicon; ids inside documents are checked by the services)*

**Likely files/modules:** `src/blocks/image/*`, `src/modules/media/ui/picker/*`, settings pages

**Testing:** E2E insert an image in a page → live `srcset` from the CDN.

---

## M7 — Publishing

### M7-1 · Lifecycle: unpublish, trash, restore, purge
**Labels:** `area:content` `type:feature`

**Description:** The state machine and its actions.

*From M6-4 (ADR 0023): images in published documents, featured images, and the site's logo and favicon draw nothing once their media is trashed or gone; the public reads are tagged `media:{id}` (or `site:{id}:media` past 50 images), and `media.trashed`/`media.restored` flush them. Purging an image leaves its `mediaId` in documents, drawn as nothing and shown in the editor as "no longer in the media library"; the keyed columns (`entries`/`entry_drafts.featured_media_id`, `site_settings.logo_media_id`/`favicon_media_id`) are set to null by `ON DELETE SET NULL`. Decide whether purging media warns about the pages that still use it.*

*From M6-3 (ADR 0022): `trash.purge` exists (`modules/media/purge.ts`, daily, in `DAILY_JOBS`) and purges media trashed for 30 days. It claims each file first (`failed`, so a concurrent restore loses), then deletes its objects, then the row. Add entries to the same job. Media's trash and restore are done (`trashMedia`, `restoreMedia`, audited, with immediate cache events).*

*From M6-2 (ADR 0021): purging media deletes `objectKeysOf(row)` (the original and every variant on the row), then the row. Its bytes are `size_bytes + variant_bytes`. `/media` stops serving a trashed item at once, but objects already cached (immutable) may remain in a CDN until it evicts them.*

*From M6-1 (ADR 0020): trashed media still counts towards the storage limit until purged (`billing/limits.ts`). Purging media deletes its objects through `storageFor` the row's own organization and site, then the row. `uploads.cleanup` (`modules/media/cleanup.ts`) does the same for refused uploads. It finds organizations with work through a SECURITY DEFINER lookup that returns ids only (migration 0007), and works in each one's own tenant context; `trash.purge` needs the same across organizations.*

*From M5-7 (ADR 0018): the lists' status filter is `ENTRY_STATUS_FILTERS` (`content/list-query.ts`); add the trash there and to `listPages`/`listPosts` (they leave trashed entries out today). Moving a page whose parent is later trashed: `movePage` already refuses a parent in the trash.*

*From M5-6 (ADR 0017): the public reads show only `status = 'published'` and `deleted_at is null`, so an unpublished or trashed entry disappears from its path, the lists and every link to it as soon as `entry.unpublished` / `entry.trashed` (already in `platform/cache/events.ts`) are returned and invalidated. Tests for that belong with the services.*

*From M5-5: documents point at entries (`entry:{id}` in links, buttons and images' links) and at media (`mediaId`). Saving checks only new references, so trashing or purging a target leaves existing pointers in drafts and revisions: they render nothing (M5-6). Decide whether purging warns about pages that still point at the entry, and keep publish's rule (no pointer to another site) in mind for anything that copies documents between sites.*

*From M5-3 (ADR 0016): a published entry cannot be trashed (CHECK `entries_trash_not_live`): unpublish in the same transaction first. Publishing refuses a page whose parent is in the trash, so trashing a page should also decide what happens to the pages below it. Restoring must give back a free path: if the old one was taken meanwhile, use `insertWithUniqueSlug`'s retry (a generated suffix), never overwrite. Every path change should go through `moveSubtree` so the pages below follow, and return `entry.moved` for live ones.*

**Depends on:** M5-3

**Acceptance criteria:**
- [x] `lifecycle.ts` pure state machine (draft / scheduled / published + trash) with permission per transition *(ADR 0024 §1: `transition(state, action)` → the new state and the right (publish, delete, delete-any), or the reason; the services and the screens ask it)*
- [x] `unpublishEntry` (+ optional "redirect this URL to…"), `trashEntry` (unpublishes in the same transaction, frees the path), `restoreEntry` (→ draft, slug re-suffixed), `purgeEntry` *(§2–5. As M7-1's brief decided, three points differ: trashing refuses a published entry (unpublish first, its own step); restore refuses a taken address, naming it, and restores nothing (no suffix); the redirect is M8-5's. A page goes to the trash and comes back with its subtree; the Home page is refused until another page is made the Home page)*
- [x] `trash.purge` daily job (30 days); trash filter in lists *(§6–7: one job, entries then media, the same 30 days; `?status=trash` on the pages and posts lists, with Restore and "Delete permanently…". §8: trashing an image in use warns, from the drawer, with the published pages that stop showing it)*

**Likely files/modules:** `src/modules/content/lifecycle.ts`, `publishing.service.ts`, lists

**Testing:** unit transition table; integration: trash → path reusable; restore conflict suffix.

### M7-2 · Scheduling via jobs
**Labels:** `area:content` `type:feature`

**Description:** Timed publishing of a frozen revision.

*V1 (ADR 0006): on Vercel Hobby the job runs when the runner is next called. That is the minute scheduler (optional, free, external) or the daily cron. Without a scheduler, a post can publish up to a day late: a known V1 limitation.*

*From M7-1 (ADR 0024): `content/lifecycle.ts` already has `schedule` (draft → scheduled) and `cancel_schedule` (scheduled → draft), both with the publish right, and refuses publishing a scheduled entry ("Cancel the schedule first") and trashing one; offer them and add the services. `trash.purge` is not recorded for want of a system actor: once there is one, decide whether it records what it deletes. `trash.purge` is the content module's job now (`content/purge.ts`).*

*From M3-5 (ADR 0010): a scheduled publish has no user in its transaction, and `record()` refuses to write without one. Add a system actor to the audit writer as an explicit, typed caller (the table already allows `actor_type = 'system'`), not as a free parameter.*

**Depends on:** M7-1, M1-3

**Acceptance criteria:**
- [x] `scheduleEntry(entryId, runAt, expectedVersion)`: validates as for publish, creates a `scheduled` revision, enqueues `entry.publish_scheduled` (`dedupe_key = entry:{id}`), status `scheduled` *(ADR 0025 §3; `runAt` is a wall-clock time in the site's zone, stored in UTC, at least a minute and at most two years ahead; `rescheduleEntry` moves the time, same revision)*
- [x] `cancelSchedule`; the job publishes the frozen revision through the same function and invalidates with `revalidateTag(..., { expire: 0 })` *(§4: `prepareForPublish` + `makeLive`, shared with Publish; the scheduler's right checked again; recorded by the system actor; idempotent)*
- [x] Schedule dialog in the site timezone; scheduled list on the site overview; failed job → email to the scheduler + banner *(§2, §5: a permanent failure returns it to draft with the reason (editor banner, overview line, email, `entry.schedule_failed`); a transient one is retried, and on the last attempt treated the same. §6–7: the system actor; `trash.purge` recorded)*

**Likely files/modules:** `src/modules/content/scheduling.*`, `src/platform/jobs/registry.ts`

**Testing:** fake-clock integration: runs within one tick; a draft edited after scheduling does not leak into the scheduled publish; E2E via the cron route.

### M7-3 · Revisions: manual save, history, restore
**Labels:** `area:content` `type:feature`

**Description:** Snapshot history.

*From M7-2 (ADR 0025): revisions now include `scheduled` ones (a frozen draft, created by whoever scheduled it). A scheduled revision that went live is the entry's `published_revision_id` (no `publish` copy is made), and a canceled schedule leaves its `scheduled` revision in the history. List them with their kind; restoring one copies it into the draft like any other. The system actor exists (`audit.recordSystem`, ADR 0025 §6) if a restore ever runs in the background.*

*From M7-1 (ADR 0024): restoring from the trash is not restoring a revision: it brings the entry back as the draft it was. Unpublishing keeps every revision; deleting for good deletes them with the entry. A trashed entry's editor is not found: its history is reachable once it is restored.*

*From M5-8 (ADR 0019): revisions keep the term ids they were published with, and a term may have been deleted since. Restoring a revision into the draft must drop the ids that are no longer terms of the site (and say so), or the restored draft cannot be saved or published.*

*From M5-4 (ADR 0003 addendum): the editor's conflict dialog (`modules/content/editor/entry-editor.tsx`) offers "Load the latest version" and "Copy my changes". Add plan §6.3's third choice here: overwrite, after saving the other version as a `save` revision.*

**Depends on:** M5-3

**Acceptance criteria:**
- [x] "Save" creates a `save` revision (deduped by content hash); cap by plan; publish revisions always kept *(ADR 0026 §2: deduped on every editable field, a typed label makes a new one; `save` and `restore` kept to the plan's 20 / 100 per entry, oldest pruned; `publish` and `scheduled` always kept; a stale version refused)*
- [x] History drawer: number, kind, author, time, label, live marker *(§5: the "History" dialog, 30 at a time; "Live", and a schedule's frozen revision with its time; Viewers read it)*
- [x] `restoreRevision` copies into the draft (+ a `restore` revision), never publishes; flags missing media *(§3: the draft is kept first; checked as a draft is now; deleted terms dropped and said so; images, links and a trashed featured image kept and flagged, a deleted one removed; a taken or reserved address refuses it. §4: the conflict dialog's overwrite, keeping exactly the version the dialog named)*

**Likely files/modules:** `src/modules/content/revision.*`, editor drawer

**Testing:** integration: restore → draft equals the revision content; the published version is unchanged.

**Hand-off (from M7-3, ADR 0026):**
- **M7-4 (preview):** the history lists revisions by title only. A preview of a revision, and of the draft after a restore, would use the same `renderDocument` path.
- **The restored draft** may hold images that are gone (flagged in the editor, left out of the page) until someone replaces them.
- **Compare UI** stays a SHOULD after V1.

### M7-4 · Preview
**Labels:** `area:rendering` `type:feature`

**Description:** Private draft preview. V1: on the app host (ADR 0006); post-V1: on the site's platform subdomain.

*From M5-6 (ADR 0017): draw a preview with the same pieces as the public page: `renderDocument` (the draft's document, checked node by node) and the theme's template through `PublicPageView`'s choices, never the cached public reads. A preview must bypass Coming soon (ADR 0013) and carry `noindex`.*

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

*From M4-4 (ADR 0012): the schema is `src/themes/_kit/tokens.ts`. Save through `parseThemeSettings(input, theme, stored)`, which refuses unknown keys, unsafe values and other themes' options and keeps the stored options of other themes; then invalidate `site:{id}:config`. `readThemeSettings` already reads everything the editor will save. `readableOn` and `luminance` are there for the contrast warning. Studio draws only `classic` and `simple` today: the other variants are this issue's. The appearance page and its `ThemePicker` exist: add the editor below it.*

*From M4-2 (ADR 0014): the social links are saved in the general settings and drawn by both footers when `footer.showSocial` (default true): the appearance editor's "social toggle" is that setting.*

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

*From M5-6 (ADR 0017, ADR 0012 addendum): Journal draws `page-full-width` and `page-landing` with one wide layout (`JournalPageWide`) and the kit's `post`, `blog-index` and `term-archive` (`_kit/templates/blog.tsx`). Replace those with Journal's own; the block styles (`_kit/blocks.css`) are shared and may be adjusted in `journal/styles.css`.*

*From M4-4 (ADR 0012): Journal is already registered, with a skeleton (layout, `centered` header, `simple` footer, page, coming-soon and not-found templates, `styles.css`, defaults: Fraunces and Source Serif 4, narrow, relaxed). What remains: the blog templates (post, blog index, archives), the full styles, and the Lighthouse work.*

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

*From M7-1 (ADR 0024): an entry can now be unpublished, trashed and deleted for good. Menu items pointing at it must be omitted while it is not published (the public reads already resolve `entry:` links only to live entries: `livePaths`). `menus.items` is JSON with no key, so an item can outlive a purged entry: resolve it like a link (nothing drawn), and consider saying so in the menu editor. `entry.unpublished` flushes `routes` and the lists at once.*

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

*From M6-4 (ADR 0023): the OG image field is here, not built in M6-4.*
- *Choose it with `MediaPicker` (`@/modules/media/shared`), as the featured image does.*
- *`seo.ogImageId` (in `entry_drafts.seo`, `site_settings.seo`) is JSON with no foreign key: check a new id with `usableImageIds(tx, org, site, [id])` on save (as `assertUsableImages` does for the featured image), and resolve it at render time with `publicImages`: its widest `w{n}` source is an absolute URL (`MEDIA_PUBLIC_BASE_URL`, default `${APP_ORIGIN}/media`). An unusable one draws no OG tag; tag the read with its `media:{id}`.*
- *A post's featured image is the natural fallback for its OG image (`PublishedEntry.featuredImage`).*
- *The site's logo for JSON-LD's `Organization` is `PublicSite.imagery.logo` (the `logo` variant, inside 640 × 240).*
- *The favicon links are already emitted by the sites page's `generateMetadata` (`icons`); keep them when the SEO metadata is merged in.*

*From M5-8 (ADR 0019): a term's published post count is its `entry_terms` rows (as `termsWithUsage` in `content/term.repository.ts` counts them, for the admin): the sitemap's "non-empty term archives" are those with any, read through a public cached function tagged like the archives (flushed by `term.changed` and publishing).*

*From M5-6 (ADR 0017): public pages carry a title (`{title} · {site name}`; the site's name alone for its home; `· Page n` on later list pages) and the robots meta by status; nothing else. Canonical URLs, descriptions, Open Graph, JSON-LD and the sitemap are here; the lists' cached reads (`loadPostList`, tag `site:{id}:list:post`) are the sitemap's source for posts.*

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

*From M7-1 (ADR 0024): plan §9's "Unpublish: offer redirect this URL to…" was left here. Unpublishing, trashing and deleting for good change no path but take the entry's away (trash frees it for others); a restore may come back at a new address when its parent moved meanwhile, and the success message names it. The services return their cache events; a redirect created with an unpublish would add `site.configChanged`.*

*From M5-3 (ADR 0016): paths change in three places, each in one transaction that returns the moved entries: `publishEntry` (slug change, its `moved`), `setHomepage` (both Home pages and the pages below them), and `moveSubtree` (shared by both). Insert the auto 301s there, from each `MovedEntry`'s `from` to `to` for live entries. Saving the reading settings with a new blog path does not move posts yet (see M5-6).*

*From M5-8 (ADR 0019): renaming a term's slug moves its archive at once and the old address answers 404. Each `term.updated` record holds `previousSlug`: add the 301 from `/{blogPath}/{category|tag}/{old}` there (in the same transaction as `updateTerm`), and decide what a deleted term's archive redirects to, if anything.*

*From M5-6 (ADR 0017): decided there: a new blog path moves the index and the archives at once; each post stays at the path it was published at until it is published again. Add the redirects for both here (old index and archives → new; a post's old path → its new one when it moves). Public paths are exact (no case or trailing-segment normalization, `…/page/1` is a 404); if redirects should cover other spellings, that is this issue's decision.*

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

*From M5-6 (ADR 0017): the public read rule (published, not in the trash, this site and language, content from the published revision) is in `modules/rendering/content.ts`. When the API reads pages and posts, move that rule behind the content module's API rather than writing it a second time, and render `contentHtml` with `renderDocument`.*

*From M3-5 (ADR 0010): the same for API keys: an `api_key` actor in the audit writer, with the key's name as the label, added as an explicit caller when the first write endpoint exists (M10-2).*

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

*From M5-5: a document written through the API must go through `saveDraft` and `publishEntry` as the editor's does: `parseDocument` (the registry's schemas, URL-safe generic embeds), and the reference checks of `modules/content/references.ts` (images and `entry:` links of this site only). Assign ids to nodes that arrive without them (ADR 0003, gap 3).*

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

*From M3-4: `inviteMember` does not check a seat limit. Plan §14 counts members plus pending invitations; add `assertLimit(tx, org, "members")` there, under the organization lock it already takes, after the permission and verified-email checks. Re-sending does not add a seat. Accepting an invitation was already counted when it was sent.*

*From M4-1 (ADR 0011): `modules/billing/plans.ts` holds the plans with only the sites limit (Free 1, Pro 5), and `assertLimit(tx, orgId, key)` (`modules/billing/limits.ts`) locks the organization's row and counts. The plan is read from `subscriptions.plan_key`; no row means Free. Add the other limits as keys of `LimitKey` with their counts, and decide here how `status`, `trial_ends_at` and `grace_until` change the plan (one function, `planOf`). The sites page already shows "n of N sites on the X plan" to those who may create sites.*

*From M6-2 (ADR 0021): storage usage includes image variants (`variant_bytes`), checked when an upload becomes ready. Avatars count towards no organization.*

*From M6-1 (ADR 0020): the storage limit is wired. `LimitKey` has `"storage"` (Free 1 GB, Pro 20 GB, binary). `assertLimit(tx, org, key, amount)` takes the bytes being added, and `requestUploads` calls it. Usage is the sum of non-failed uploads' declared sizes, trashed included. Over the limit after a downgrade: nothing is deleted, and new uploads are refused.*

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

*From M4-5 (ADR 0015): suspending and unsuspending must take the site's row lock as `setSiteStatus` does (`lockSiteStatus` / `updateSiteStatus` in `modules/sites/repository.ts`) and emit `site.statusChanged`, so staff and tenants cannot interleave; tenants can never set or leave `suspended`. No site page emits third-party script: the GA4 and Plausible snippets are off (`ANALYTICS_SCRIPTS_ACTIVE`) until a consent and privacy decision is made and built, which no issue owns yet. `script-src` for site pages needs no third-party origin until then. Audit `created_at` is the transaction's start, so overlapping changes can be listed out of order; decide whether the writer should use `clock_timestamp()`.*

*From M3-5 (ADR 0010): the audit log is never purged in V1 (no `audit_purge_before()`), and platform events (logins, password changes: rows with no organization) still have no reader. Both are this issue's: a definer function or platform policy for staff to read them, and the retention decision. The activity page shows tenants neither the client address nor the request id that every row stores; the staff view is where those are for.*

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

*From M5-7 (ADR 0018): **pre-launch dependency, the Home page backfill.** Sites created before M5-3 have no Home page (no entry at `/`, `site_settings.homepage_entry_id` null); their public `/` shows the name and tagline, and their owners are offered "Create the home page". Before public launch, decide and, if wanted, run a one-off backfill as a separate maintenance command (never in a request):*
- *Scope: sites not deleted with no live entry at `/` in their default locale **and** a null `homepage_entry_id`; one explicit target (`--org` / `--site` / `--all`).*
- *Each site gets what `createHomePage` makes (a draft page titled "Home", slug `home`, at `/`, and `homepage_entry_id`), in its own transaction, under the site's settings lock, as the site's Owner (audited). A site that has a Home page, or gets one meanwhile, is skipped: running it twice changes nothing.*
- *A dry run first, with counts (sites found, made, skipped, failed), and the same counts after.*
- *Verification: afterwards no site has zero or two entries at `/`; every `homepage_entry_id` names the entry at `/`; public pages are unchanged (the new Home pages are drafts, so `/` still shows the name and tagline until published).*

**Depends on:** M12-1

**Acceptance criteria:**
- [ ] Playwright acceptance suite automates the full §23 journey with two tenants on staging; manual run with real domains recorded
- [ ] Lighthouse ≥ 90 on both themes; public cache hit after the first view; publish-to-live < 5 s; admin p95 < 500 ms on staging data
- [ ] axe: no serious or critical issues on admin key screens and theme templates
- [ ] Light k6 test on renderer cache misses and publish
- [ ] Legal pages, production checklist, launch sign-off

**Likely files/modules:** `tests/e2e/acceptance/*`, `docs/runbooks/launch-checklist.md`

**Testing:** the acceptance suite is green on the release candidate.
