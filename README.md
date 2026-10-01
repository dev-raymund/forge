# Forge CMS

Multi-tenant CMS SaaS: one Next.js 16 app serving the admin, every tenant website and a REST API.

- **What to build now:** [docs/architecture/v1-build-plan.md](docs/architecture/v1-build-plan.md)
- **Issues:** [docs/architecture/v1-github-issues.md](docs/architecture/v1-github-issues.md)
- **Long-term architecture (D-01…D-40):** [docs/architecture/cms-architecture.md](docs/architecture/cms-architecture.md)
- **Decisions made during implementation:** [docs/adr/](docs/adr/)

## Local setup

Requirements: Node ≥ 22 (CI uses 24), Docker.

```bash
npm install
cp .env.example .env.local        # local defaults work with docker-compose
npm run dev:services              # Postgres 17, PgBouncer (transaction mode), RustFS (S3), Mailpit
npm run db:migrate                # apply migrations as forge_owner (direct connection)
npm run dev                       # http://localhost:3000
```

One origin serves everything, as in the V1 deployment (`cms.forgelinetechnologies.com`, ADR 0006):

| URL | What |
|---|---|
| `/login`, `/{orgSlug}/…` | Admin |
| `/api/v1/…` | REST API |
| `/s/{address}/…` | Tenant sites, e.g. `http://localhost:3000/s/acme/about` |
| `/media/…` | Media (from M6) |
| `/api/internal/cron`, `/api/internal/cron/daily` | Job runner (needs `Bearer $CRON_SECRET`) |

Tenant sites on their own hosts (platform subdomains, custom domains) are post-V1 and switched on with `HOST_ROUTING_ENABLED`.

## Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | Generates route types, then `tsc --noEmit` |
| `npm run lint` | ESLint, including module-boundary rules |
| `npm test` | Unit tests (Vitest, no I/O) |
| `npm run test:integration` | Integration tests against Postgres through PgBouncer (needs `dev:services`) |
| `npm run test:e2e` | Playwright against a production build (`npm run build` first) |
| `npm run db:generate` | Generate a migration from schema changes (review the SQL before committing) |
| `npm run db:generate:custom` | Create an empty migration for hand-written SQL (RLS, grants, functions) |
| `npm run db:migrate` | Apply migrations as `forge_owner` |

`drizzle-kit push` is not used: every schema change is a generated, reviewed migration (D-32).

## Layout

```text
src/app/(admin)            admin root layout (app host)
src/app/(sites)/render     tenant-site root layout (reached only via proxy rewrite)
src/app/api                route handlers (auth, REST v1, internal, health)
src/modules/<module>       business logic: schema, services, repositories, queries, actions
src/platform/<concern>     infrastructure: db, jobs, cache, storage, email, observability, config
src/blocks, src/themes     editor block registry, built-in themes
tests/                     unit, integration, e2e
```
