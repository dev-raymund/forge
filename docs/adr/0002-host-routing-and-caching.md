# ADR 0002: Host routing through `proxy.ts`, Cache Components with tag invalidation

| | |
|---|---|
| **Status** | Accepted for V1. Proven locally on a production build (`next start`, `*.localhost`). **Vercel preview confirmation pending** (needs the M0-2 accounts; the same Playwright spec runs against a deployment) |
| **Date** | 2026-09-30 |
| **Spike** | S1 / M0-4, with the production proxy and cache primitives of M1-7 |
| **Decisions touched** | D-02, D-27, D-37 (clarified, not changed) |
| **Amended** | 2026-10-01 by ADR 0006: V1 serves tenant sites at `/s/{address}` on one host; host-based routing stays, behind `HOST_ROUTING_ENABLED` (post-V1) |

> **2026-10-01, ADR 0006.** The caching and renderer findings below hold unchanged. What changed is addressing:
> - The internal route is now `/render/[site]/[[...path]]`, where `[site]` is a locator: `address~acme` or `host~client.com`.
> - V1 reaches sites via `/s/{address}` on the single app host.
> - The host-based routing proven here is kept behind `HOST_ROUTING_ENABLED` for platform subdomains and custom domains on paid hosting.
> - The E2E spec now runs on one host, and the Vercel confirmation targets a Hobby deployment.

## Question

Can one Next.js 16 deployment serve the admin on the app host and every tenant site on its own host (subdomains and custom domains unknown at build time) from one route? Can we keep internal paths and admin Server Actions unreachable from tenant hosts? Do `'use cache'` + `cacheTag` + `updateTag` / `revalidateTag` give "publish → fresh on the next request" for such hosts?

## What was built

- **`src/proxy.ts`** (Next 16's middleware, Node runtime) is a thin shell over the pure `decideRoute()` in `src/platform/routing/hosts.ts`:
  - Normalise the host: lowercase, strip port and trailing dot, IDN → punycode.
  - App host (from `APP_ORIGIN`) → admin and API. Any other host → rewrite to `/render/{host}{path}`.
  - Assign `x-request-id` on the request and the response. `x-vercel-id` is reused; otherwise a UUIDv7 is minted; client-supplied ids are ignored.
  - Guards: direct `/render/*` → 404 on every host; a `Next-Action` request on a non-app host → 404.
  - `?__host=` override outside Vercel production.
  - If `APP_ORIGIN` is missing, only `/api/health*` answers; everything else is 503.
- **`src/platform/cache`**:
  - Tag builders for the V1 taxonomy (`host`, `site`, `config`, `routes`, `entry`, `list`, `media`).
  - The single pure map `tagsFor(event)`.
  - `invalidate(events, "action" | "background")`, and the `cms` profile.
- **Spike read path** (`spikes/rendering/queries.ts`): `resolveSiteByHost(host)` (tag `host:{h}`) and `getSiteView(orgId, siteId)` (tags `site:{id}`, `site:{id}:config`), both `'use cache'` + `cacheLife("cms")`, reading Postgres through `withPlatform` / `withTenant`. The placeholder page `/render/[host]/[[...path]]` renders them.
- **Spike write paths:**
  - The Server Action `publishTaglineAction` → `invalidate(…, "action")` → `updateTag`. It is driven from `/dev/cache`, which is also the admin-pattern page.
  - The route handler `POST /api/dev/revalidate` → `invalidate(…, "background")` → `revalidateTag(tag, { expire: 0 })`.
  - Both refuse to run on Vercel production. The handler needs the cron secret on previews.

## Evidence

`tests/e2e/rendering-spike.spec.ts` (9 tests, real Chromium, production build, tenant sites seeded as `forge_app` through PgBouncer) plus `src/platform/routing/hosts.test.ts` (30-case decision table) and `src/platform/cache/cache.test.ts`:

| Claim | Test | Result |
|---|---|---|
| Two hosts render different content from the same route | `two hosts render different content…` | ✔ |
| Unknown host → real **404 status** (not a streamed soft 404) | `an unknown host gets a real 404 status` | ✔ |
| Direct `/render/*` → 404 on the app host and on site hosts | `direct /render/* requests 404…` | ✔ |
| Site hosts can't reach admin routes, the API or Server Actions | `site hosts can't reach…` (admin paths become site paths; `Next-Action` POST → 404) | ✔ |
| Every response carries `x-request-id` | `every response carries a request id` | ✔ |
| `?__host=` renders a tenant on the app host outside production | `outside production, ?__host=…` | ✔ |
| Public data really is cached: a DB write without invalidation stays invisible (same `renderedAt`) | `public data is cached…` | ✔ |
| Server Action + `updateTag` → fresh on the **very next** request; another site's cache entry survives | `Server Action publish (updateTag)…` (fails when `invalidate` is removed: checked) | ✔ |
| Route handler + `revalidateTag(tag, { expire: 0 })` → fresh on the very next request | `job-style route handler…` | ✔ |

## Decisions

1. **Routing** as built above. The proxy is not a security boundary for tenant data: RLS and services are. It separates the surfaces and keeps internal paths internal.
2. **Invalidation modes:**
   - Server Actions use `updateTag` for immediate tags (read-your-writes).
   - Route handlers and jobs use `revalidateTag(tag, { expire: 0 })`, because `updateTag` is only allowed in Server Actions.
   - Broad tags always use `revalidateTag(tag, "max")` (stale-while-revalidate).
   - Everything goes through `invalidate(events, mode)`; nothing calls the Next APIs directly.
3. **`cms` cacheLife profile:** `stale: 300, revalidate: 86_400, expire: 604_800`.
   - Freshness comes from tags; time is only the self-healing bound for a missed invalidation, and one day meets long-term §24.4.
   - `stale` 5 min is the client router cache. An author's own navigation after publishing is covered by `updateTag`.
   - `expire` 7 days: an entry idle for a week is recomputed on the next request instead of being served very stale.
4. **Admin pattern under Cache Components:**
   - The admin never uses `'use cache'`.
   - Layouts and pages render a **static shell** (headings, navigation chrome, forms' static parts).
   - Everything that depends on the request goes into async components **inside `<Suspense>`**: `getCurrentUser()` (M2-1), `requireSiteContext()` (M3-2), and any tenant data. Those components call cookies/headers or `await connection()`, which makes them dynamic by construction.
   - `/dev/cache` is the reference: static `<h1>` and copy, with the site list streamed after `await connection()`.
   - Redirects for signed-out users happen in those dynamic components (or in the proxy as UX only), never in the shell.
5. **Public renderer pattern:** the site page reads `params` *outside* `<Suspense>` and resolves the host before anything streams, so `notFound()` produces a real 404 status. See discovery 1 for what that requires.

## Discoveries (clarifications to the plan; no scope change)

1. **Reading `params` outside `<Suspense>` needs static params for every dynamic segment.** The root layout already returns a placeholder host. The optional catch-all `[[...path]]` also needs `generateStaticParams() → [{ path: [] }]`; otherwise the build fails with "blocking-prerender-dynamic". With both, unknown hosts and paths render on demand, blocking, and are then cached. Wrapping the page in `<Suspense>` instead would make an unknown host or path a streamed **200** (soft 404), which is wrong for SEO. M4-3 and M5-6 keep this structure.
2. **The build-time placeholder host must not touch the database.** Otherwise `next build` needs a migrated database (on Vercel: the production database at build time). The renderer returns early for `BUILD_PLACEHOLDER_HOST`.
3. **Bare `localhost` is a tenant host now.** Anything probing the app must use the app host: Playwright's readiness URL is `http://app.localhost:3100/api/health`, and uptime checks must target `APP_ORIGIN`.
4. **`host:` tags can exceed Next's 256-character limit.** A 253-character hostname makes a 258-character tag. `tags.host()` shortens such tags to a 200-character prefix plus a hash, found by a unit test.
5. **`updateTag` is Server-Action-only.** This confirms the two invalidation modes; `invalidate()` makes the choice explicit at each call site.
6. **Server Action ids are callable even when the page that references them 404s.** Spike and admin actions must check authorization inside the action, never rely on the page. The spike action refuses on Vercel production; real actions will call `requireSiteContext()` (M3-2).

## Still to confirm on Vercel (M0-2 dependency)

Run the same spec against a preview deployment (runbook §5):

```sh
E2E_BASE_URL=https://<preview>.vercel.app DATABASE_URL=<Neon pooled URL of the preview branch> \
CRON_SECRET=<preview secret> VERCEL_AUTOMATION_BYPASS_SECRET=<bypass> npx playwright test tests/e2e/rendering-spike.spec.ts
```

This checks that tag invalidation propagates across Vercel's regions and instances, and that the CDN/ISR layer honours the tags from the inner `'use cache'` calls. Nothing in the design depends on local-only behaviour, but Vercel's caching is the one place where the platform, not our code, has the last word. So this is a real confirmation step, blocked only on account access.

---

## Addendum (M4-3, 2026-10-10): the spike is replaced by the renderer

- The spike's read path is now the rendering module: `resolveSite(locator)` (tag `host:{address}`) and `loadPublicSite(orgId, siteId)` (tags `site:{id}`, `site:{id}:config`), in `src/modules/rendering/queries.ts` (ADR 0013). Decisions 3 and 5 above stand unchanged.
- **Removed, as the M0-4 hand-off asked:** `spikes/rendering/`, `/dev/cache`, `POST /api/dev/revalidate`, `tests/e2e/rendering-spike.spec.ts`. The admin pattern of decision 4 lives in every admin page now. `tests/e2e/renderer.spec.ts` keeps the spike spec's guarantees on the real renderer: real 404s, `/render/*` internal, no admin, API or Server Action from a site path, framing and request-id headers, cached until invalidated, `updateTag` fresh on the next request with other sites untouched.
- The background mode (`revalidateTag(…, { expire: 0 })`) has no caller until scheduled publishing (M7-2); it stays unit-tested in `src/platform/cache/cache.test.ts`. The Vercel confirmation of §"Still to confirm" now runs `tests/e2e/renderer.spec.ts`.
- **A new lint rule:** a `'use cache'` function must take its tenant (`siteId`, `orgId`, `locator`, `host`, …) as an argument.
