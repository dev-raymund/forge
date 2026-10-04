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
| 12 | Vercel Firewall rate-limit rule for sign-in and account requests (§2a) | ☐ pending owner |

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
   - Deployments that share a database share its job queue. An email job is valid only for the origin that queued it (its links must be on that `APP_ORIGIN`), so when two previews with different URLs share a branch, one can pick up the other's email job and refuse it. Give a preview its own branch when its emails matter. Production never shares its database.

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
   - **Production:** `APP_ORIGIN=https://cms.forgelinetechnologies.com`, `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `CRON_SECRET`, database, storage, email, Sentry and Turnstile values. Leave `BETTER_AUTH_URL` unset: it defaults to `APP_ORIGIN`.
   - **Preview:** leave `APP_ORIGIN` **unset**. It defaults to the branch URL (`VERCEL_BRANCH_URL`), so auth and links work on every preview. Set `BETTER_AUTH_SECRET` here too, with a **different** value from Production. Open previews by their branch URL: auth rejects requests from any other origin, including the per-deployment URL.
   - **Local (M2-2):** `APP_ORIGIN=http://localhost:3000`, and open the app at exactly that address. Auth rejects requests from any other origin, so `127.0.0.1:3000` or an old `app.localhost:3000` setting gets "This request didn't come from the Forge app". `EMAIL_PROVIDER=mailpit` delivers verification and reset emails to http://localhost:8025.
   - **Auth (M2-1):** readiness (`/api/health/ready`) reports the `auth` group as failed when the secret is missing; sign-in then answers 503. The fixed development secret is accepted only on `localhost`, never on Vercel.
   - **Google sign-in (optional, M2-3):** set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` together. Without them email/password works, no Google button is shown, and the Google routes answer 404.
     1. Google Cloud → APIs & Services → Credentials → OAuth client ID, type "Web application".
     2. Authorized redirect URI: `https://cms.forgelinetechnologies.com/api/auth/callback/google` (for local use add `http://localhost:3000/api/auth/callback/google`). No JavaScript origins are needed.
     3. Consent screen scopes: `openid`, `email`, `profile` only. While the app is in "Testing", only the listed test users can sign in.
     4. **Check it by hand once** (it cannot be automated without a real account): sign up with Google; log out; log in with Google again (same user); then try Google with the address of an existing, *unverified* password account, which must be refused with "isn't connected to Google".
   - Leave `HOST_ROUTING_ENABLED`, `SITES_ROOT_DOMAIN` and `MEDIA_PUBLIC_BASE_URL` unset (post-V1).
5. **Crons:** `vercel.json` declares one daily cron (`/api/internal/cron/daily`, 03:00 UTC; Hobby runs it within that hour). Hobby rejects anything more frequent at deploy time. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when `CRON_SECRET` is set.
6. Previews are protected by Vercel Authentication by default. For automated tests against a preview, create a Protection Bypass for Automation secret (or use a Shareable Link).

## 2a. Firewall: rate-limit sign-in and account requests

Better Auth's own limiter is on in production (3 attempts per 10 s per address for sign-in, sign-up and password changes). It counts per function instance, so it slows one client down but is not a hard ceiling. The Vercel Firewall rule is the outer limit, and it has to be created in the project (it is not part of the repository).

The account screens are forms that post to **their own path** as Server Actions, not to `/api/auth/*`. The rule must therefore cover both:

| What | Method and path |
|---|---|
| Auth API | `POST /api/auth/…` |
| Login, sign-up, verify, forgot and reset password | `POST /login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password` |
| Account page (name, password, sessions) | `POST /account` |

One rule with OR groups is enough. In the dashboard (Firewall → Rules → New rule), or with the CLI from the linked project:

```sh
vercel firewall rules add "Auth and account POSTs" \
  --condition '{"type":"method","op":"eq","value":"POST"}' --condition '{"type":"path","op":"pre","value":"/api/auth/"}' \
  --or --condition '{"type":"method","op":"eq","value":"POST"}' --condition '{"type":"path","op":"eq","value":"/login"}' \
  --or --condition '{"type":"method","op":"eq","value":"POST"}' --condition '{"type":"path","op":"eq","value":"/signup"}' \
  --or --condition '{"type":"method","op":"eq","value":"POST"}' --condition '{"type":"path","op":"eq","value":"/verify-email"}' \
  --or --condition '{"type":"method","op":"eq","value":"POST"}' --condition '{"type":"path","op":"eq","value":"/forgot-password"}' \
  --or --condition '{"type":"method","op":"eq","value":"POST"}' --condition '{"type":"path","op":"eq","value":"/reset-password"}' \
  --or --condition '{"type":"method","op":"eq","value":"POST"}' --condition '{"type":"path","op":"eq","value":"/account"}' \
  --action rate_limit --rate-limit-window 60 --rate-limit-requests 30 --rate-limit-keys ip --rate-limit-action deny
```

- 30 POSTs per minute per address is far above what a person does on these screens and far below what guessing needs.
- Check the rule in the Firewall tab afterwards (`vercel firewall rules list --expand`), and how many rate-limit rules the plan allows before adding others.
- To verify: 31 quick POSTs to `/login` from one address; the last is refused by the platform (HTTP 429) before it reaches the app.

## 3. DNS for `cms.forgelinetechnologies.com`

At the DNS provider of `forgelinetechnologies.com`, add the single record Vercel asks for, typically `cms CNAME cname.vercel-dns.com.`. Vercel then issues the certificate. Nothing else on the domain changes.

## 4. Cloudflare R2

1. Buckets `forge-media-prod` and `forge-media-preview` (free tier). **No custom domain:** media is served by the app at `/media/{key}` (ADR 0006, M6-2).
2. CORS on each bucket for presigned uploads from the app:

   ```json
   [{ "AllowedOrigins": ["https://cms.forgelinetechnologies.com"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type", "content-length"], "MaxAgeSeconds": 3600 }]
   ```

   Add the preview origin(s) you test uploads from to the preview bucket.
3. An API token scoped to these buckets only (Object Read & Write) → `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY`.
4. In Vercel, set the storage variables for Production and Preview (ADR 0008):
   - `STORAGE_BUCKET`
   - `STORAGE_ENDPOINT` = `https://<account-id>.r2.cloudflarestorage.com`
   - `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`
   - `STORAGE_REGION` can stay unset (`auto`), and so can `STORAGE_DRIVER`: on Vercel the driver is S3.
   - Until these are set, readiness reports the `storage` group as invalid.
5. Before first use, run the storage contract against a test bucket:
   ```sh
   TEST_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com TEST_S3_BUCKET=forge-media-preview \
   TEST_S3_ACCESS_KEY_ID=<id> TEST_S3_SECRET_ACCESS_KEY=<secret> \
   npm run test:integration -- tests/integration/storage.test.ts
   ```

Local development needs none of this: the local driver stores files in `.storage/`.

## 5. Resend, Sentry, Turnstile, Stripe

- **Resend:** add `cms.forgelinetechnologies.com` as the sending domain. Publish its SPF, DKIM and DMARC records; these are DNS records only and add no website.
  - **Production:** set `RESEND_API_KEY` and `EMAIL_FROM`, e.g. `Forge <no-reply@cms.forgelinetechnologies.com>`. Resend is the default provider there.
  - **Previews:** leave email unset; the console provider logs instead of sending. To send from a preview, set `EMAIL_PROVIDER=resend` plus the key for that environment.
  - Readiness reports the `email` group as invalid on production until both are set (ADR 0007).
- **Sentry:** a Next.js project; DSN into `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`; `SENTRY_ORG`, `SENTRY_PROJECT` and `SENTRY_AUTH_TOKEN` for source-map upload during the Vercel build. To verify (M1-2), with `CRON_SECRET` set:
  ```sh
  curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://cms.forgelinetechnologies.com/api/internal/sentry-test
  ```
  The response carries the `requestId` and `sentryEventId`. The event appears in Sentry tagged with `requestId` and `module`, and with the commit SHA as its release.
- **Turnstile:** one widget for `cms.forgelinetechnologies.com` (sign-up), "Managed" mode. Set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.
  - **Production: required.** Without both keys the `turnstile` group fails readiness and auth answers 503: sign-up is never served there without the challenge.
  - **Previews and local:** leave both unset; sign-up then has no challenge. Setting only one of the two is a configuration error.
  - The challenge is checked inside Better Auth, in front of `/api/auth/sign-up/email`, so the form and a direct call are both covered (ADR 0004, M2-2).
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
