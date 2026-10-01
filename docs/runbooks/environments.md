# Runbook: provisioning the V1 environment (M0-2)

V1 is a **development / private-beta deployment on free tiers** under one existing domain (ADR 0006, plan §0):

```text
forgelinetechnologies.com                 existing Forgeline domain (untouched)
        └── cms.forgelinetechnologies.com Forge: admin, /api/v1, /s/{address} sites, /media
```

The repository side is done: `vercel.json`, `.env.example`, and local services via `docker-compose.yml`. The account steps below must be done by the owner of the accounts.

| Service | Plan | Why it's enough for V1 | Watch out for |
|---|---|---|---|
| Vercel | **Hobby** (free) | One project, one custom subdomain, CDN, functions, daily cron | **Non-commercial use only.** Crons at most daily. 300 s max function duration. 1 h runtime logs. Monthly usage caps |
| Neon | **Free** | Postgres 17 + pooled endpoint + branches | Scale-to-zero can't be disabled (≈0.5 s cold start after idle) |
| Cloudflare R2 | Free tier | 10 GB, no egress fees; no Cloudflare DNS zone needed | Needs a Cloudflare account |
| Resend | Free | 3,000 emails/month, 100/day | One sending domain |
| Sentry | Developer (free) | 5k errors/month | — |
| Turnstile | Free | Sign-up protection | — |
| Stripe | Test mode | Build and test billing | Live payments = commercial use → paid Vercel plan |
| GitHub Actions | Free (public repo) | CI | — |

## Status

| # | Resource | Status |
|---|---|---|
| 1 | GitHub repository (`dev-raymund/forge`) | ✔ exists |
| 2 | Neon Free project + roles | ☐ pending owner |
| 3 | Vercel Hobby project linked to the repo | ☐ pending owner |
| 4 | DNS: `cms.forgelinetechnologies.com` → Vercel | ☐ pending owner |
| 5 | Cloudflare R2 bucket(s) + CORS + scoped token | ☐ pending owner |
| 6 | Resend sending domain verified | ☐ pending owner |
| 7 | Sentry project | ☐ pending owner |
| 8 | Cloudflare Turnstile keys | ☐ pending owner |
| 9 | Stripe test account + Pro price | ☐ pending owner |
| 10 | Environment variables set in Vercel | ☐ pending owner |
| 11 | Optional: external per-minute scheduler for the job runner | ☐ optional |

## 1. Neon (Free)

1. Create a project on **Postgres 17**, in the region nearest most editors. The Vercel function region must match it (step 2).
2. On the Free plan the compute scales to zero when idle and that can't be turned off. The first request after idle waits about half a second. This is accepted for V1. Raise the minimum compute only on a paid plan.
3. **Roles.** Create them **with SQL, not the Neon console**. Roles created in the console, CLI or API are made members of `neon_superuser`. SQL-created roles are not, and `forge_app` must never be able to bypass RLS. Run as the project owner role:

   ```sql
   CREATE ROLE forge_owner LOGIN PASSWORD '<generate>' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
   CREATE ROLE forge_app   LOGIN PASSWORD '<generate>' NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
   CREATE ROLE forge_lookup NOLOGIN NOSUPERUSER NOBYPASSRLS;   -- owns the token-lookup functions
   GRANT forge_lookup TO forge_owner;
   ALTER DATABASE neondb OWNER TO forge_owner;   -- or the database you use
   ALTER SCHEMA public OWNER TO forge_owner;
   REVOKE ALL ON SCHEMA public FROM PUBLIC;
   GRANT USAGE ON SCHEMA public TO forge_app;
   ```

   The integration suite asserts that `forge_app` is not a member of any superuser or BYPASSRLS role (`tests/integration/rls.test.ts`). Run it against Neon once (step 1b).
4. **Connection strings:**
   - `DATABASE_URL`: the **pooled** host (`-pooler`) with user `forge_app` (runtime, Vercel).
   - `DATABASE_MIGRATION_URL`: the **direct** host with user `forge_owner` (local/CI only; never in Vercel).
5. Apply migrations: `DATABASE_MIGRATION_URL=<direct owner URL> npm run db:migrate`.
6. Preview branches (optional): the Neon ↔ Vercel integration can give each preview its own branch. Otherwise previews share a non-production branch.

### 1b. Prove RLS on Neon itself

Run the RLS spike tests against a throwaway Neon branch through the pooled endpoint:

```bash
TEST_DATABASE_OWNER_URL='<direct URL, forge_owner, branch>' \
TEST_DATABASE_APP_URL='<pooled URL, forge_app, branch>' \
npm run test:integration -- tests/integration/rls.test.ts
```

Record the result in `docs/adr/0001-rls-withtenant.md`.

## 2. Vercel (Hobby)

1. Import `dev-raymund/forge` from GitHub as a new project. Leave the Root Directory empty; the framework is Next.js.
2. Settings: **Fluid compute on**. Set the function region to the Neon region.
3. **Domain:** add `cms.forgelinetechnologies.com` to the project. Vercel shows the DNS record to create (step 3). No other domains are needed.
4. **Environment variables** (every name in `.env.example`; mark secrets Sensitive; never set `DATABASE_MIGRATION_URL`):
   - **Production:** `APP_ORIGIN=https://cms.forgelinetechnologies.com`, `BETTER_AUTH_URL` = the same, `CRON_SECRET`, database, storage, email, Sentry and Turnstile values.
   - **Preview:** leave `APP_ORIGIN` **unset**. It defaults to the branch URL (`VERCEL_BRANCH_URL`), so auth and links work on every preview.
   - Leave `HOST_ROUTING_ENABLED`, `SITES_ROOT_DOMAIN` and `MEDIA_PUBLIC_BASE_URL` unset (post-V1).
5. **Crons:** `vercel.json` declares one daily cron (`/api/internal/cron/daily`, 03:00 UTC; Hobby runs it within that hour). Hobby rejects anything more frequent at deploy time. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when `CRON_SECRET` is set.
6. Previews are protected by Vercel Authentication by default. For automated tests against a preview, create a Protection Bypass for Automation secret (or use a Shareable Link).

## 3. DNS for `cms.forgelinetechnologies.com`

At the DNS provider of `forgelinetechnologies.com`, add the single record Vercel asks for, typically `cms CNAME cname.vercel-dns.com.`. Vercel then issues the certificate. Nothing else on the domain changes.

## 4. Cloudflare R2

1. Buckets `forge-media-prod` and `forge-media-preview` (free tier). **No custom domain:** media is served by the app at `/media/{key}` (ADR 0006, M6-2).
2. CORS on each bucket for presigned uploads from the app:

   ```json
   [{ "AllowedOrigins": ["https://cms.forgelinetechnologies.com"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type", "content-length"], "MaxAgeSeconds": 3600 }]
   ```

   Add the preview origin(s) you test uploads from to the preview bucket.
3. An API token scoped to these buckets only (Object Read & Write) → `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY`. `STORAGE_ENDPOINT` is the account's S3 endpoint.

## 5. Resend, Sentry, Turnstile, Stripe

- **Resend:** add `cms.forgelinetechnologies.com` as the sending domain. Publish its SPF, DKIM and DMARC records; these are DNS records only and add no website. Then set `EMAIL_FROM`, e.g. `Forge <no-reply@cms.forgelinetechnologies.com>`.
- **Sentry:** a Next.js project; DSN into `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`; `SENTRY_ORG`, `SENTRY_PROJECT` and `SENTRY_AUTH_TOKEN` for source-map upload during the Vercel build. To verify (M1-2), with `CRON_SECRET` set:
  ```sh
  curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://cms.forgelinetechnologies.com/api/internal/sentry-test
  ```
  The response carries the `requestId` and `sentryEventId`. The event appears in Sentry tagged with `requestId` and `module`, and with the commit SHA as its release.
- **Turnstile:** one widget for `cms.forgelinetechnologies.com` (sign-up).
- **Stripe:** test mode, product "Pro" with a monthly price → `STRIPE_PRICE_PRO`. The webhook endpoint is added in M11-2. Going live means commercial use, so it needs a paid Vercel plan first.

## 6. Optional: per-minute job runner (free)

Vercel Hobby runs the job runner only daily; `after()` kicks cover jobs enqueued by requests. For minute-level work (scheduled publishing, retries), have a free external scheduler call the runner:

- **URL:** `https://cms.forgelinetechnologies.com/api/internal/cron`
- **Method:** `GET`, header `Authorization: Bearer <CRON_SECRET>`
- **Every:** 1–5 minutes

Any free cron service works, e.g. cron-job.org. Alternatively, use a GitHub Actions `schedule` workflow, which is free for this public repository but only runs every 5 minutes at best, and often late. The endpoint returns 404 without the secret. Nothing in the app changes; on a paid plan, replace it with a per-minute Vercel cron.

## 7. Confirm the spikes on the deployment

Once the deployment exists, run the remaining checks. Each result goes into its ADR:

1. **RLS through Neon's pooler (ADR 0001):** §1b above.
2. **Routing and tag invalidation on Vercel (ADR 0002/0006).** The spec seeds its own sites and reaches them at `/s/{address}`:
   ```sh
   E2E_BASE_URL=https://cms.forgelinetechnologies.com \
   DATABASE_URL=<Neon POOLED forge_app URL of the same branch> \
   CRON_SECRET=<cron secret> \
   npx playwright test tests/e2e/rendering-spike.spec.ts
   ```
   To run it against a protected preview instead, also pass `VERCEL_AUTOMATION_BYPASS_SECRET`. The `/dev/*` spike pages refuse to run on Vercel production, so run the publish tests against a preview.
3. **Sentry (M1-2):** the curl in §5.

## 8. Later: moving to production infrastructure (post-V1)

No redesign is needed (ADR 0006, "Exit path"):

- **Free, first:** serve public sites from a second origin (a second subdomain, or later a separate registrable domain).
- **Paid plan:**
  - `HOST_ROUTING_ENABLED=true` + `SITES_ROOT_DOMAIN` (wildcard platform subdomains);
  - custom domains (M9, Vercel Domains API);
  - a per-minute Vercel cron;
  - a media CDN domain via `MEDIA_PUBLIC_BASE_URL`.
