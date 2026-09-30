# Runbook: provisioning environments (M0-2)

This runbook creates the external accounts and resources Forge needs. The repository side is done: `vercel.json` crons, `.env.example`, and local services via `docker-compose.yml`. The account steps must be done by the owner of the accounts.

Hostnames are placeholders from the V1 plan. Substitute the real domains everywhere.

| Placeholder | Purpose | DNS host |
|---|---|---|
| `app.forgecms.com` | Admin, auth, `/api/v1` | Vercel |
| `*.forge-host.com` | Tenant sites (wildcard) | **Vercel nameservers** (needed for the wildcard certificate) |
| `media.forgecdn.com` | Media CDN | **Cloudflare zone** (R2 custom domains must be in a Cloudflare zone) |

## Status

| # | Resource | Status |
|---|---|---|
| 1 | Domains registered (3) | ☐ pending owner |
| 2 | Vercel Pro project linked to the GitHub repo | ☐ pending owner (no GitHub remote yet) |
| 3 | Neon project + roles + preview branching | ☐ pending owner |
| 4 | Cloudflare R2 buckets + media custom domain + CORS | ☐ pending owner |
| 5 | Resend domain verified | ☐ pending owner |
| 6 | Sentry project | ☐ pending owner |
| 7 | Cloudflare Turnstile keys | ☐ pending owner |
| 8 | Stripe test account + Pro price | ☐ pending owner |
| 9 | Scoped Vercel API token (Domains API) | ☐ pending owner |
| 10 | Environment variables set in Vercel (production + preview) | ☐ pending owner |

## 1. Neon

1. Create a project on **Postgres 17**, in the region nearest most editors. The Vercel function region must match it (step 2).
2. **Production branch:** disable scale-to-zero, set a minimum compute size, and allow autoscaling up (v1-build-plan §4, D-05).
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

   The integration suite asserts that `forge_app` is not a member of any superuser or BYPASSRLS role (`tests/integration/rls.test.ts`). Run it against Neon once (step 1b below).
4. **Connection strings:**
   - `DATABASE_URL`: the **pooled** host (`-pooler`) with user `forge_app` (runtime, Vercel).
   - `DATABASE_MIGRATION_URL`: the **direct** host with user `forge_owner` (CI only; never in the Vercel runtime).
5. Install the Neon ↔ Vercel integration so each preview deployment gets its own branch.

### 1b. Prove RLS on Neon itself

Run the RLS spike tests against a throwaway Neon branch through the pooled endpoint:

```bash
TEST_DATABASE_OWNER_URL='<direct URL, forge_owner, branch>' \
TEST_DATABASE_APP_URL='<pooled URL, forge_app, branch>' \
npm run test:integration -- tests/integration/rls.test.ts
```

Record the result in `docs/adr/0001-rls-withtenant.md`.

## 2. Vercel

1. Push the repository to GitHub, create a **Pro** project from it, and leave the Root Directory empty. Crons at one-minute frequency require Pro.
2. Settings: **Fluid compute on**. Set the function region to the Neon region. Enable skew protection.
3. Domains:
   - `app.forgecms.com`
   - `forge-host.com` with its nameservers moved to Vercel, then the wildcard `*.forge-host.com`
4. Environment variables: every name in `.env.example`, set per environment. Mark secrets as Sensitive. Never set `DATABASE_MIGRATION_URL` in Vercel.
5. Production deploys: until the GitHub Actions production workflow exists (plan §34), keep auto-deploy on and run migrations manually before merging schema changes.

## 3. Cloudflare R2

1. Buckets `forge-media-prod` and `forge-media-preview` (plus `forge-private-*` when exports arrive).
2. Custom domain `media.forgecdn.com` on the media bucket. The `forgecdn.com` zone must be on Cloudflare.
3. Transform rule on `media.forgecdn.com` adding `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` to every response.
4. CORS on the media bucket:

   ```json
   [{ "AllowedOrigins": ["https://app.forgecms.com"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type", "content-length"], "MaxAgeSeconds": 3600 }]
   ```

5. An API token scoped to these buckets only (Object Read & Write).

## 4. Resend, Sentry, Turnstile, Stripe

- **Resend:** add the sending domain and publish SPF, DKIM and DMARC. `EMAIL_FROM` uses that domain.
- **Sentry:** a Next.js project; DSN into `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`; `SENTRY_ORG`, `SENTRY_PROJECT` and `SENTRY_AUTH_TOKEN` for source-map upload during the Vercel build. To verify from a preview (M1-2), with `CRON_SECRET` set:
  ```sh
  curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<preview-host>/api/internal/sentry-test
  ```
  The response carries the `requestId` and `sentryEventId`. The event appears in Sentry tagged with `requestId` and `module`, and with the commit SHA as its release.
- **Turnstile:** a widget for `app.forgecms.com` (sign-up) and one covering the sites domain (forms, later).
- **Stripe:** test mode, product "Pro" with a monthly price → `STRIPE_PRICE_PRO`. The webhook endpoint is added in M11-2.
- **Vercel API token:** scoped to the team/project, used only by the domains module (M9).

## 5. Confirm the spikes on a preview deployment

Once Vercel and a Neon preview branch exist, run the remaining checks against a preview. Each result goes into its ADR:

1. **Migrate the preview branch:** `DATABASE_MIGRATION_URL=<direct owner URL> npm run db:migrate`.
2. **RLS through Neon's pooler (ADR 0001):** §1b above.
3. **Host routing and tag invalidation on Vercel (ADR 0002).** This requires the preview env to have `APP_ORIGIN` = the preview URL and a `CRON_SECRET`. Create a protection-bypass secret in the Vercel project settings.
   ```sh
   E2E_BASE_URL=https://<preview>.vercel.app \
   DATABASE_URL=<Neon POOLED forge_app URL of the preview branch> \
   CRON_SECRET=<preview cron secret> \
   VERCEL_AUTOMATION_BYPASS_SECRET=<bypass secret> \
   npx playwright test tests/e2e/rendering-spike.spec.ts
   ```
   The spec seeds its own tenant sites and reaches them through `?__host=`.
4. **Sentry (M1-2):** the curl in §4.
