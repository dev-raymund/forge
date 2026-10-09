# ADR 0006: V1 runs on one hostname, with tenant sites at `/s/{address}`

| | |
|---|---|
| **Status** | Accepted for V1 (development and private beta) |
| **Date** | 2026-10-01 |
| **Decisions touched** | D-02 (domain separation) deferred for V1; D-27, D-37 unchanged; ADR 0002 routing extended |
| **Supersedes for V1** | v1-build-plan §0 "three domains", §11 custom domains as a V1 requirement, the per-minute Vercel cron |

## Context

There is no budget for paid infrastructure. The existing Forgeline domain is `forgelinetechnologies.com`, and Forge gets exactly one subdomain: **`cms.forgelinetechnologies.com`**. The plan had assumed:
- three registrable domains (app, a wildcard sites domain on Vercel nameservers, a Cloudflare media zone);
- Vercel Pro (per-minute cron, the Domains API);
- custom domains in V1.

None of that is available. The core SaaS architecture is unchanged: modular monolith, multi-tenancy, RLS, content and revisions, jobs, RBAC, the REST API, and the storage abstraction. Only how requests reach it changes.

This is a **development / private-beta deployment**, not the commercial production infrastructure. Vercel Hobby is for non-commercial personal use only, so charging customers requires upgrading (see "Exit path").

## Decision

### URL architecture (one origin)

```text
forgelinetechnologies.com            (existing, untouched)
  └── cms.forgelinetechnologies.com  → one Vercel project (Hobby)

  /login, /signup, /{orgSlug}/…      admin (Server Components + Server Actions)
  /api/auth/…, /api/v1/…, /api/app/… route handlers
  /api/internal/cron[/daily]         job runner (Bearer CRON_SECRET)
  /s/{address}/…                     tenant sites (public, read-only)
  /_forge/preview/{token}            draft preview (signed, scoped) — M7
  /media/{key}                       media objects (immutable keys) — M6
```

- **Site address.**
  - A site's public key is its **platform address**: the existing `domains` row of kind `subdomain`, whose `hostname` column holds the label (`acme`). It is globally unique (`domains.hostname` UQ).
  - `sites.slug` is only unique per organization, so it can't identify a site on its own.
  - The address has DNS-label shape (`[a-z0-9-]`, ≤ 63), so the same value becomes `acme.<sites domain>` later with no data migration.
  - **No schema change.**
- **Routing** (`src/platform/routing/hosts.ts`, unit-tested table):
  - *Path mode*, always on: `/s/{address}/…` is rewritten to the internal renderer `/render/address~{address}/…`.
  - *Host mode*, post-V1: behind `HOST_ROUTING_ENABLED`. A host other than the app host is rewritten to `/render/address~{label}/…` (platform subdomain) or `/render/host~{hostname}/…` (custom domain).
  - Both modes feed the **same renderer**: site → organization → content → theme → navigation → SEO. Only the lookup and the base path for links differ (`siteBasePath`).
  - In path mode any hostname serves the app, so `*.vercel.app` previews work without configuration.
- **Reserved organization slugs** gain `s` and `media`.
- **Media.** The public URL is `MEDIA_PUBLIC_BASE_URL`, defaulting to `${APP_ORIGIN}/media`.
  - M6 serves `/media/{key}` through a route handler that streams from object storage (R2) with `Cache-Control: public, max-age=31536000, immutable`, so Vercel's CDN caches each object after the first request.
  - Storage keys stay independent of the public URL; a CDN domain later is a configuration change.
  - Uploads still go directly to storage with presigned URLs.
- **API.** `cms.forgelinetechnologies.com/api/v1`. The `api` module stays independent of the host, so it can move later.
- **Previews.**
  - `/_forge/preview/{token}` on the same host. The token is HMAC-signed, expires after 15 min, and is bound to site + entry + user.
  - It renders the draft uncached with `noindex`, inside the site layout, and never trusts URL parameters.

### Jobs on Vercel Hobby

Hobby crons run **at most once a day**, with ±59 min precision. A per-minute schedule fails deployment. So:
- `vercel.json` has one cron: `/api/internal/cron/daily` (03:00 UTC), which enqueues the maintenance jobs **and runs the runner**.
- Low latency comes from `kickJobs()` (`after()`), which runs the job types a request just enqueued.
- For minute-level work (scheduled publishing in M7, retries), point a **free external scheduler** at `GET /api/internal/cron` with `Authorization: Bearer $CRON_SECRET` (runbook §5). No code change; on a paid plan it becomes a per-minute Vercel cron again.
- Without an external scheduler, scheduled posts and retries wait for the next kick or the daily run. This is documented as a V1 limitation.
- The claim length (900 s) still exceeds Hobby's 300 s function limit, so ADR 0005's guarantees hold.

### Deferred to post-V1 infrastructure

- Wildcard platform subdomains.
- Custom domains: the Vercel Domains API, TXT verification, SSL provisioning, and the `domain.check` polling job.
- A separate media domain or CDN.
- Separate admin and API hosts.

The data model (`domains` with `kind`, `status`, `verification_token`, `is_primary`), the host-mode routing and the `host:` cache tags remain, so these features are added without touching content or tenancy.

## Security model on a shared origin

Tenant **data** isolation is unchanged: RLS, `withTenant`, composite foreign keys, and the isolation suite.

What changes is **origin isolation**. Admin pages and public tenant pages now share one origin, so script running on a public page would run with the privileges of a signed-in admin's session (same-origin requests carry the cookie). A cookie path can't exclude `/s/`.

V1 therefore relies on **tenants never being able to put script on the origin**:

1. **No tenant HTML or JavaScript anywhere.**
   - Content is structured JSON rendered by the closed renderer (no stored HTML, no `dangerouslySetInnerHTML`; XSS corpus, ADR 0003).
   - Themes are code, not uploads.
   - Embeds are sandboxed iframes of allow-listed (or URL-safety-validated) third-party origins.
   - SVG uploads are not allowed.
   - M6's `/media` route serves only allow-listed MIME types with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. It never serves HTML or JS, which also prevents service-worker registration.
2. **Public pages never act as the admin.**
   - The site tree never reads cookies or the session; ESLint forbids `@/modules/auth` under `src/app/(sites)/`. Its pages are identical for every visitor and cacheable.
   - **`Next-Action` requests on `/s/*` are rejected (404) by the proxy.**
   - Every Server Action re-authenticates and authorizes inside the action (`requireSiteContext`), because action ids are callable regardless of the page (ADR 0002).
   - Next's Origin check stops cross-site action calls.
3. **URL parameters never authorize.**
   - `/s/{address}` selects which *published* content to show; nothing more.
   - `/{orgSlug}/…` in the admin is navigation only; membership is checked by `requireOrgContext` (D-08).
   - Drafts are reachable only with a valid preview token.
4. **Framing**, set per surface by the proxy:
   - admin: `X-Frame-Options: DENY` + `frame-ancestors 'none'`;
   - site pages: `SAMEORIGIN` + `frame-ancestors 'self'`, so only the admin's preview pane can embed them;
   - both: `object-src 'none'; base-uri 'self'`.
   - The full `script-src` policy remains M12-1. Cached public pages cannot carry per-request nonces, which is one more reason point 1 must hold.
5. **Third-party scripts on tenant pages** (the GA4 / Plausible settings) would run on the admin's origin. On the shared V1 origin, only those two vendors' official snippets may be emitted, built by our code from validated IDs. No free-form "head code".

**Residual risk.** A bug that lets tenant-controlled script execute on a public page (an escaping bug in the renderer, a vulnerable dependency) would reach admins who visit that page. With hosts separated, it couldn't. This is accepted for a private beta with trusted tenants. **Before opening sign-ups to untrusted tenants, move public sites to a separate origin** (Exit path).

## Cost profile (all free tiers)

| Service | Free tier used | Limits that matter |
|---|---|---|
| Vercel Hobby | Hosting, CDN, functions, 1 daily cron | Non-commercial only; 300 s max function duration; 1 h runtime logs; 1M invocations; 100 GB transfer / 10 GB origin transfer; 4 active-CPU hours per month |
| Neon Free | Postgres + pooled endpoint | Scale-to-zero can't be turned off (≈0.5 s cold start); small storage/compute quota |
| Cloudflare R2 | Object storage | 10 GB storage, no egress fees; no Cloudflare zone needed (served via `/media`) |
| Resend Free | Email | 3,000/month, 100/day; sending domain = `cms.forgelinetechnologies.com` (DNS records only) |
| Sentry Developer | Errors | 5k errors/month |
| Cloudflare Turnstile, Stripe test mode | Abuse, billing | Free; live billing implies commercial use → paid Vercel |
| GitHub Actions | CI | Free for this public repository |

No Redis, search engine, workers, extra databases, extra Vercel projects or extra domains.

## Exit path (no redesign)

1. **First, still free:** serve public sites from a second *origin*. Either:
   - a second free subdomain (e.g. `sites.forgelinetechnologies.com`) added to the same Vercel project, with the proxy refusing admin paths there; or
   - later, a separate registrable domain (preferred for cookies and Safe Browsing).

   Path mode works there unchanged.
2. **On paid hosting:**
   - `HOST_ROUTING_ENABLED=true` with `SITES_ROOT_DOMAIN` (wildcard platform subdomains);
   - then custom domains (M9);
   - a per-minute Vercel cron instead of the external scheduler;
   - a media CDN domain via `MEDIA_PUBLIC_BASE_URL`.

## Evidence

- `src/platform/routing/hosts.test.ts` (56 cases): path mode, host mode, locators, address validation.
- `tests/e2e/rendering-spike.spec.ts` (9 tests, production build on one host; replaced in M4-3 by `tests/e2e/renderer.spec.ts`, ADR 0013):
  - two sites at `/s/…` with their base paths;
  - real 404s for unknown or malformed addresses;
  - `/render` blocked;
  - site pages can't reach admin routes, the API or Server Actions;
  - framing headers per surface, and no cookies set by site pages;
  - caching and both invalidation modes.
- `tests/unit/lint-boundaries.test.ts`: the session can't be imported under `(sites)/`.
- `tests/e2e/cron.spec.ts`: the daily cron enqueues and runs jobs.

---

## Addendum (M4-2, 2026-10-10): §5 is built

The GA4 and Plausible settings are emitted as §5 allows, on live sites only, through `next/script`, from IDs validated when saved and again when written (ADR 0014 §3). No other third-party or tenant script reaches a site page. M12-1's `script-src` must allow `https://www.googletagmanager.com` and `https://plausible.io` on site pages.
