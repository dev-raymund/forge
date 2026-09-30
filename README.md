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
npm run dev                       # http://app.localhost:3000
```

Tenant sites are served on `*.sites.localhost` (browsers resolve `*.localhost` to loopback), e.g. `http://acme.sites.localhost:3000`.

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
