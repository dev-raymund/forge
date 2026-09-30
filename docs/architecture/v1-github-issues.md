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

**Description:** Create the production and preview infrastructure so every later phase deploys to real services.

**Depends on:** M0-1

**Acceptance criteria:**
- [ ] Vercel Pro project connected to the repo (Fluid compute on; region chosen next to Neon; previews on PRs)
- [ ] Neon project; `forge_owner` and `forge_app` roles; production branch with scale-to-zero **off**; Neon–Vercel preview branching
- [ ] Cloudflare R2 buckets `forge-media-{env}`; custom domain `media.forgecdn.com`; CORS for presigned PUT from the app origin
- [ ] Domains:
  - `app.forgecms.com` on Vercel
  - `forge-host.com` on **Vercel nameservers** with wildcard `*.forge-host.com`
  - `forgecdn.com` zone on Cloudflare
- [ ] Resend domain verified (SPF/DKIM/DMARC); Sentry project; Cloudflare Turnstile keys; Stripe test account; scoped Vercel API token
- [ ] Environment variables set per environment:

  | Group | Variables |
  |---|---|
  | Database | `DATABASE_URL` (pooled, `forge_app`), `DATABASE_MIGRATION_URL` (CI only) |
  | Hosts | `APP_ORIGIN`, `SITES_ROOT_DOMAIN`, `MEDIA_PUBLIC_BASE_URL` |
  | Auth | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID/SECRET` |
  | Email | `RESEND_API_KEY`, `EMAIL_FROM` |
  | Storage | `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID/SECRET` |
  | Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO` |
  | Domains | `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` |
  | Security | `CRON_SECRET`, `PREVIEW_TOKEN_SECRET`, `TURNSTILE_SECRET_KEY`/`NEXT_PUBLIC_TURNSTILE_SITE_KEY` |
  | Observability | `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` |
  | Staff | `PLATFORM_ADMIN_EMAILS` |

**Status (2026-09-30):** *Partially done.* The repository side is complete: `vercel.json` crons, `.env.example`, and [`docs/runbooks/environments.md`](../runbooks/environments.md) with exact provisioning steps. **Every account item above is pending the owner.** This session had no credentials for Vercel, Neon, R2, Resend, Sentry, Stripe or Turnstile, no domain purchases, and no GitHub remote to connect Vercel to. Runbook discovery: create `forge_app` and `forge_owner` **with SQL, not the Neon console**. Console-, CLI- and API-created roles join `neon_superuser`.

**Likely files/modules:** `vercel.json` (crons), `.env.example`, `docs/runbooks/environments.md`

**Testing:** a preview deployment answers on the app host and on a `*.forge-host.com` test subdomain.

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

**Status:** Proven locally on a production build. The Vercel preview run is pending the M0-2 accounts (runbook §5).

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
- [ ] `jobs` table (platform class) with `dedupe_key` partial unique index
- [ ] `jobs.enqueue(tx, type, payload, { runAt?, dedupeKey?, maxAttempts? })` inside the caller's transaction; payloads validated by per-type Zod schemas in a registry
- [ ] Runner: claims with `FOR UPDATE SKIP LOCKED`; exponential backoff with jitter; `dead` after max attempts; reaper for expired locks; stops at ~75% of the time budget
- [ ] `/api/internal/cron` (every minute) and `/api/internal/cron/daily` (03:00) authenticated with `CRON_SECRET`; configured in `vercel.json`
- [ ] `kickJobs()` helper using `after()`

**Likely files/modules:** `src/platform/jobs/*`, `src/app/api/internal/cron/*`, `vercel.json`

**Testing:** integration with a fake clock: success, retry with backoff, dead-letter, concurrent runners never double-claim, dedupe.

### M1-4 · Email: provider interface, Resend adapter, templates, `email.send` job
**Labels:** `area:platform` `type:infra`

**Description:** Replaceable transactional email, always sent through jobs.

**Depends on:** M1-3

**Acceptance criteria:**
- [ ] `EmailProvider` interface; Resend adapter using the idempotency key = job ID; console/Mailpit adapter for dev; capture adapter for tests
- [ ] React Email base layout + templates: verify email, reset password, invitation, trial ending, payment failed
- [ ] `email.send` job; failures are retried and never throw into the caller; configuration faults are logged with an explanation

**Likely files/modules:** `src/platform/email/*`

**Testing:** unit tests for template rendering; integration: an enqueued email is delivered to the capture adapter exactly once despite a retry.

### M1-5 · Storage driver: interface + S3-compatible adapter
**Labels:** `area:platform` `type:infra`

**Description:** `StorageDriver` (plan §8) with the S3 implementation used for R2 in production and MinIO locally.

**Depends on:** M0-2

**Acceptance criteria:**
- [ ] Interface: `createUpload` (presigned PUT signing content-type and content-length), `head`, `readRange`, `get`, `put`, `delete`, `publicUrl`
- [ ] S3 adapter configured by env (endpoint, region `auto`, bucket)
- [ ] Key builder `o/{org}/s/{site}/m/{media}/v{n}/{variant}/{name}.{ext}`

**Likely files/modules:** `src/platform/storage/*`

**Testing:** integration against MinIO: presigned PUT round trip, a content-length mismatch is rejected, HEAD/readRange/delete.

### M1-6 · Test harness + isolation-suite framework
**Labels:** `area:platform` `type:test` `risk:high`

**Description:** Make tenant isolation testable from the first tenant table onward.

**Depends on:** M1-1

**Status:** Partially done. The two helpers below are deferred until the things they test exist; nothing in them blocks M2.

**Acceptance criteria:**
- [x] Integration DB per Vitest worker (template database clone), migrations applied once — `tests/setup/integration-global.ts` migrates `forge_test_template` once, then clones `forge_test_w1..4`
- [x] Factories: user, org (+ membership), site, entry, media, term — `tests/fixtures/factories.ts`; the term is created by `createPublishedEntry`, and `createTenantGraph` fills every tenant table
- [x] Isolation suite (`tests/integration/isolation.test.ts`):
  - reads the table-class registry (`src/platform/db/table-classes.ts`, which replaced `tenantTable()`, see M1-1) and diffs it against the live catalog (`tests/isolation/coverage.ts`)
  - asserts RLS enabled + forced for each table
  - seeds orgs A and B
  - runs registered read functions (`tests/isolation/tenant-reads.ts`) under A's context and asserts no B rows. It starts with one no-WHERE read per tenant table; repository reads are added there as they land.
- [ ] Helper to register actions and route handlers for "B's IDs → 404" checks — **deferred to the first action/route handler (M2)**; its shape depends on the action wrapper and session helpers
- [ ] Captured-email helper for E2E (reads the capture adapter or Mailpit) — **deferred to M1-4**, which creates the capture adapter

**Likely files/modules:** `tests/setup/*`, `tests/isolation/*`, `tests/fixtures/*`

**Testing:** the suite fails if a table is created without RLS (a fixture proves it). ✔ `detects an unprotected tenant table` creates a table with `organization_id` and no RLS as the owner and asserts the audit reports it.

### M1-7 · `proxy.ts` host routing, guards and cache primitives
**Labels:** `area:rendering` `type:infra`

**Description:** Classify hosts and route requests.

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

**Description:** Production Better Auth setup per ADR 0004.

*From M0-6: the tables and migration were delivered in M1-1. Start from `spikes/auth/auth.ts` and use `identityDb()` for the adapter. Mind the Cache Components note in ADR 0004 (discovery 9).*

**Depends on:** M0-6, M1-1, M1-4

**Acceptance criteria:**
- [ ] Tables `users`, `auth_accounts`, `auth_sessions`, `auth_verifications` via reviewed migration
- [ ] Handler at `/api/auth/[...all]`; `trustedOrigins` = app origin; cookie host-only, secure, `SameSite=Lax`; 7-day sliding / 30-day absolute; `cookieCache` off
- [ ] Auth emails routed through `email.send` jobs with an `after()` kick
- [ ] `modules/auth` exports `getCurrentUser()` (React `cache`), `requireUser()` and `requireVerifiedUser()`; lint forbids Better Auth imports elsewhere

**Likely files/modules:** `src/modules/auth/*`, `src/app/api/auth/[...all]/route.ts`

**Testing:** integration: session create/resolve/revoke; an unverified user is rejected by `requireVerifiedUser`.

### M2-2 · Sign-up, login, logout, email verification UI
**Labels:** `area:auth` `type:feature`

**Description:** The account screens.

*From M1-7: add the admin cookie-presence redirect to `proxy.ts` (UX only; the real check stays in `requireUser()`).*

**Depends on:** M2-1

**Acceptance criteria:**
- [ ] `/signup` (email, password ≥ 12, Turnstile), `/login`, logout in the account menu, `/verify-email` with resend (throttled)
- [ ] Generic login error; `?next=` restricted to same-origin paths
- [ ] Verified-email banner in the admin until verified

**Likely files/modules:** `src/app/(admin)/(auth)/*`, `src/modules/auth/ui/*`

**Testing:** E2E: sign up → verify via the captured email → log out → log in.

### M2-3 · Password reset and Google OAuth
**Labels:** `area:auth` `type:feature`

**Description:** Recovery flow and social login.

**Depends on:** M2-1

**Acceptance criteria:**
- [ ] `/forgot-password` → always the same response; `/reset-password` with a single-use 60-minute token; all sessions revoked on reset; notification email
- [ ] Google OAuth sign-in and sign-up; auto-link **only** when Google asserts a verified email equal to the account's verified email

**Likely files/modules:** `src/modules/auth/*`, auth pages

**Testing:** E2E reset flow; integration test of the linking rule with a mocked provider response.

### M2-4 · Account page, sessions and auth hardening
**Labels:** `area:auth` `type:feature`

**Description:** Self-service account management plus abuse controls.

*From M0-6: Better Auth's limiter uses in-memory storage by default, which is per instance on Vercel. The WAF rule is the real control (ADR 0004, discovery 8).*

**Depends on:** M2-2, M1-5

**Acceptance criteria:**
- [ ] `/account`: name, avatar (upload via the storage driver), change password (revokes other sessions), list and revoke sessions
- [ ] Vercel WAF rate-limit rule on `/api/auth/*`; Better Auth limiter enabled
- [ ] Audit rows for login, logout, password change (org-less entries)

**Likely files/modules:** `src/app/(admin)/account/*`, `src/modules/auth/actions.ts`

**Testing:** E2E revoke session in browser A → browser B is logged out on the next request.

---

## M3 — Organizations & RBAC

### M3-1 · Tenancy schema and RLS policies
**Labels:** `area:tenancy` `type:feature` `risk:high`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** The multi-tenant core tables.

**Depends on:** M1-1, M1-6, M2-1

**Acceptance criteria:**
- [ ] Tables: `organizations`, `organization_members`, `organization_invitations`, `roles` (5 system rows seeded), `subscriptions` (plan/trial columns)
- [ ] Standard RLS; membership policies visible via `app.user_id`; `resolve_invitation(token_hash)` `SECURITY DEFINER` returning minimum columns
- [ ] Reserved org slugs enforced

**Likely files/modules:** `src/modules/tenancy/schema.ts`, `drizzle/*`

**Testing:** isolation suite covers these tables; a user sees only their own orgs in the switcher query.

### M3-2 · Permission catalog, policies, context resolvers
**Labels:** `area:tenancy` `type:feature` `risk:high`

**Description:** Authorization for everything that follows.

**Depends on:** M3-1

**Acceptance criteria:**
- [ ] `permissions.ts` catalog (plan §13), with role → permission sets in code and `entries.{type}.{action}` keys
- [ ] `can(ctx, permission, resource?)` with `.own` ownership rules; unknown roles hold nothing
- [ ] `requireOrgContext(orgSlug)` and `requireSiteContext(orgSlug, siteSlug)` (React `cache`) → `RequestContext`; 404 for non-members
- [ ] `policies.ts` helpers used by later modules

**Likely files/modules:** `src/modules/tenancy/{permissions,policies,context}.ts`

**Testing:**
- generated matrix test (catalog × roles)
- wildcard and unknown-role cases
- context returns 404 for a non-member

### M3-3 · Onboarding (organization), org switcher, org settings, ownership transfer
**Labels:** `area:tenancy` `type:feature`

**Description:** Create and manage organizations.

**Depends on:** M3-2

**Acceptance criteria:**
- [ ] `/onboarding` step 1 creates the org, the Owner membership and a trial subscription (14 days)
- [ ] `/` redirects to the last org's sites, or `/onboarding`
- [ ] Org switcher in the admin shell (URL-based, D-08)
- [ ] `/{org}/settings`: rename, change slug (with redirect from the old slug for 30 days, optional), transfer ownership (Owner only)

**Likely files/modules:** `src/app/(admin)/onboarding/*`, `src/app/(admin)/[orgSlug]/*`, `src/modules/tenancy/*`

**Testing:** E2E sign up → onboarding → org created; two orgs open in two tabs work independently.

### M3-4 · Invitations and member management
**Labels:** `area:tenancy` `type:feature`

**Description:** Invite users and manage roles.

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

**Depends on:** M3-1

**Acceptance criteria:**
- [ ] `audit_logs` table; `forge_app` has INSERT/SELECT only
- [ ] `audit.record(tx, { action, resourceType, resourceId, metadata })` taking actor, request ID and IP from the context
- [ ] `/{org}/activity`: paginated list with filters (site, user, action, date); Admin+

**Likely files/modules:** `src/modules/audit/*`, activity page

**Testing:** a rolled-back mutation leaves no audit row; UPDATE on `audit_logs` fails for `forge_app`.

---

## M4 — Sites

### M4-1 · Sites schema, create site, subdomain, limits
**Labels:** `area:sites` `type:feature`

> *Schema delivered early in M1-1: the tables, constraints and RLS exist. This issue's remaining work is its services, UI and tests.*

**Description:** Sites and their default hostname.

**Depends on:** M3-2

**Acceptance criteria:**
- [ ] Tables `sites`, `site_settings`, `domains` (subdomain rows; platform class)
- [ ] `createSite` in one transaction:
  - validates the subdomain (charset, reserved words, uniqueness)
  - creates the site (`coming_soon`) + settings + `domains` row
  - checks the plan limit (`assertLimit` stub with plan in code)
  - audits
- [ ] `/{org}/sites` grid and `/{org}/sites/new`; `changeSubdomain`, soft `deleteSite`

**Likely files/modules:** `src/modules/sites/*`, `src/modules/domains/schema.ts`, site pages

**Testing:** subdomain validation table; limit reached → `LimitExceeded`; isolation suite for sites.

### M4-2 · Site overview, settings and onboarding steps 2–3
**Labels:** `area:sites` `type:feature`

**Description:** Configure a site.

**Depends on:** M4-1, M4-4

**Acceptance criteria:**
- [ ] `/{org}/sites/{site}` overview: status, primary URL, launch checklist (pages, menu, SEO, domain, publish), recent activity
- [ ] `/…/settings`: general (name, tagline, language, timezone, social links), reading (blog path, posts per page), analytics (GA4 ID, Plausible domain), with Zod-validated JSONB groups and optimistic `version`
- [ ] `/onboarding` steps 2 (site) and 3 (theme) reuse the same actions

**Likely files/modules:** site pages, `src/modules/sites/{settings,validation}.ts`

**Testing:** invalid GA4 ID rejected; E2E onboarding end to end.

### M4-3 · Renderer foundation: host → site, coming soon, unknown and suspended hosts
**Labels:** `area:rendering` `type:feature` `risk:high`

**Description:** Serve sites by hostname with correct caching.

*From M0-4: start from `spikes/rendering/queries.ts` and the current `/render/[host]/[[...path]]` page. Keep static params for both segments, resolve the host outside `<Suspense>` (real 404s), skip the database for the build placeholder, and delete the `/dev/cache` and `/api/dev/revalidate` spike routes (ADR 0002).*

**Depends on:** M1-7, M4-1

**Acceptance criteria:**
- [ ] `(sites)/render/[host]/layout.tsx` with `resolveSiteByHost` (`'use cache'`, tag `host:{h}`) → site, org, primary, status
- [ ] Unknown host → platform "site not found"; `suspended` → "site unavailable"; `coming_soon` → theme's coming-soon page with `noindex` (preview token bypass comes in M7-4)
- [ ] Non-primary host → 308 to primary (except `/_forge/preview/*`)
- [ ] Cached data functions take `siteId`/`host` as arguments; lint rule for `'use cache'` functions without a tenant argument

**Likely files/modules:** `src/modules/rendering/*`, `src/app/(sites)/render/[host]/*`

**Testing:** E2E via `*.localhost` hosts; subdomain change invalidates the host tag.

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

**Testing:** E2E: publish site → the subdomain serves real pages (after M5), and robots no longer disallows.

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

*From M0-5: button, columns, embed and spacer already exist in `spikes/editor/`. Still open: the concrete list of embed form providers (ADR 0003, gap 9) and top-level drop snapping (gap 4).*

**Depends on:** M5-4

**Acceptance criteria:**
- [ ] Block registry entries (`schema`, Tiptap extension, NodeView, render) for `button`, `columns`/`column` (2–3, no nesting), `embed` (YouTube, Vimeo + allow-listed form providers; privacy URLs), `spacer`
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

**Depends on:** M6-1

**Acceptance criteria:**
- [ ] `processImage(mediaId)` inside `completeUpload`: `sharp` with `limitInputPixels`, auto-rotate, metadata stripped; widths 400 (square thumb), 800, 1600, 2400 (≤ original) as WebP → `variants` JSONB
- [ ] Route `maxDuration`/memory configured; p95 processing time logged
- [ ] `media.forgecdn.com` serving with immutable caching, `nosniff` and sandbox CSP (Cloudflare rule documented)
- [ ] A `<ResponsiveImage>` kit component produces `srcset`/`sizes`/`width`/`height`

**Likely files/modules:** `src/modules/media/processing.ts`, `src/themes/_kit/components/ResponsiveImage.tsx`, `docs/runbooks/media-cdn.md`

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

**Description:** Private draft preview on the site's platform subdomain.

**Depends on:** M5-6

**Acceptance criteria:**
- [ ] `createPreviewToken(entryId)`: HMAC (`PREVIEW_TOKEN_SECRET`), 15 min, bound to site + entry + user
- [ ] `/_forge/preview/{token}` on `{sub}.forge-host.com` renders the draft via **uncached** queries, with `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`; `frame-ancestors` allows the app origin
- [ ] Editor preview pane (iframe) + "open in new tab"; autosave flushed before preview; works for coming-soon sites

**Likely files/modules:** `src/modules/rendering/preview.*`, `src/app/(sites)/render/[host]/platform/preview/*`

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
- [ ] `/sitemap.xml` (published, indexable, non-empty archives) and `/robots.txt` per host

**Likely files/modules:** `src/modules/seo/*`, `src/app/(sites)/render/[host]/{sitemap.xml,robots.txt}/*`

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

## M9 — Custom domains

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

**Depends on:** all feature milestones

**Acceptance criteria:**
- [ ] Admin nonce-based CSP via the proxy; security headers per surface; WAF rules for `/api/auth/*`, `/api/v1/*`
- [ ] Isolation suite covers 100% of tenant tables; actions and API routes registered for the 404 checks; `npm audit` clean of high/critical findings; OWASP ZAP baseline on staging (external pentest if budget allows)
- [ ] `/platform` staff console (allow-list `PLATFORM_ADMIN_EMAILS` + verified email): search orgs/sites, suspend/unsuspend with a reason (audited, invalidates `site:{id}`)
- [ ] Alerts (5xx rate, cron heartbeat, dead jobs, domain failures, Stripe webhook failures) and uptime checks (admin, API, canary site on subdomain and custom domain)
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
