# ADR 0001: Thin RLS through `withTenant()` on the pooled connection

| | |
|---|---|
| **Status** | Accepted for V1. Proven locally through PgBouncer in transaction mode; **Neon confirmation pending** (needs a Neon project, see below) |
| **Date** | 2026-09-30 |
| **Spike** | S2 / M0-3 (v1-github-issues.md) |
| **Decisions touched** | D-04, D-05 (clarified, not changed) |

## Question

Can organization A be kept from reading organization B's rows by Postgres itself, even when application code forgets a `WHERE organization_id = …`, while connecting through a transaction-mode pooler like Neon's pooled endpoint? And what does that cost?

## Setup (as production will run)

- Runtime role `forge_app`: owns nothing, `NOBYPASSRLS`, not a member of any superuser or BYPASSRLS role.
- Connection: `pg` Pool → **PgBouncer 1.26 in transaction mode** → Postgres 17. This is Neon's pooled-endpoint shape. `docker-compose.yml` runs it locally and in CI.
- Every tenant query runs in `withTenant({ orgId, userId }, fn)`: `BEGIN; SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true); …; COMMIT`.
- Policies compare against `app_current_org_id()`, which returns `nullif(current_setting('app.org_id', true), '')::uuid`.
- RLS is enabled **and forced** on all 17 tenant and membership tables (migration 0002).

## Evidence

`npm run test:integration` runs `tests/integration/rls.test.ts`: **58 tests, all passing** (2026-09-30, local). Each claim below is a test that runs through the pooler:

| Claim | Test |
|---|---|
| A sees only A's rows **with no WHERE clause**, for every tenant/membership table | `isolation with the WHERE clause omitted` (17 tables) |
| No tenant context → zero rows, inside a transaction and outside one | same block (17 tables + raw pooled query) |
| A user-only context lists that user's organizations and no tenant data | `a user-only context…` |
| Inserting or moving a row into another organization fails (`42501`, WITH CHECK) | `writes are checked too` |
| UPDATE/DELETE aimed at B's ids from A's context affect 0 rows | same block |
| Cross-site and cross-org references fail at the database (`23503`) | `composite foreign keys…` |
| 60 interleaved concurrent A / B / no-context transactions never see each other's rows | `tenant context never leaks across pooled connections` |
| Runtime role cannot bypass RLS or assume the lookup role | `runtime role` |
| Every table is classified; exactly the tenant/membership classes have RLS + FORCE | `classification` |
| `audit_logs` rejects UPDATE/DELETE; `entry_revisions` rejects UPDATE | `append-only tables` |

**Latency** (`npx tsx scripts/spikes/rls-latency.ts`, 300 iterations, local Docker):

| | p50 | p95 |
|---|---|---|
| 3 bare queries | 0.90 ms | 5.08 ms |
| `withTenant` (transaction + `set_config` + same 3 queries) | 1.64 ms | 9.79 ms |
| **Overhead** | **+0.74 ms** (3 extra round trips) | |

On Neon the overhead is about 3 × the function↔Neon round trip (≈ 1 ms each when co-located, so ≈ 3 ms per *uncached* tenant transaction). Public pages are served from the cache, so this lands on admin requests and cache misses. Acceptable for V1.

## Decision

Keep **thin RLS** as designed (v1-build-plan §4.3): one policy template, FORCE on every tenant table, and `withTenant()` as the only application path to tenant tables. No fallback is needed.

## Discoveries (clarifications to the plan; no scope change)

1. **FORCE also binds the table owner, so the token lookups need their own role.** A `SECURITY DEFINER` function owned by `forge_owner` sees *nothing* under FORCE. `resolve_api_key()` and `resolve_invitation()` are therefore owned by **`forge_lookup`** (NOLOGIN, not BYPASSRLS). It has `SELECT` on exactly `api_keys` and `organization_invitations` and a role-scoped policy `FOR SELECT TO forge_lookup USING (true)`. `forge_app` can execute the functions but cannot `SET ROLE forge_lookup` (tested).
2. **Reassigning function ownership needs `CREATE` on the schema for the new owner.** Migration 0002 grants `CREATE` to `forge_lookup` only around the `ALTER FUNCTION … OWNER TO`, then revokes it.
3. **The `''` gotcha is real.** After a transaction-local `set_config`, the same server connection reports `current_setting('app.org_id', true) = ''` (not NULL), and `''::uuid` raises an error. `nullif(…, '')` in `app_current_org_id()` is required. Tested on a pinned direct connection.
4. **Session-level `SET` must never be used.** Behind PgBouncer in transaction mode it would stay on the server connection and leak to the next client. `withTenant()` uses only `set_config(…, true)`. This is enforced by code review; the concurrent-interleaving test guards the helper.
5. **Neon roles must be created with SQL.** Roles created in the Neon console, CLI or API join `neon_superuser`. The runtime role must not. The runbook creates `forge_owner`, `forge_app` and `forge_lookup` with SQL, and a test asserts `forge_app` inherits no superuser or BYPASSRLS role.
6. **FK checks bypass RLS by design, and that's what we want.** The composite foreign keys still reject cross-site and cross-org references even when the referenced row is invisible to the current tenant.
7. **Local and CI-only privileges.** The test harness gives `forge_owner` `CREATEDB` and `pg_signal_backend`, so it can clone per-worker databases and drop the previous run's. These are never granted on Neon.

## Still to confirm on Neon (M0-2 dependency)

The same suite and latency script must be run against a Neon branch through its `-pooler` endpoint (runbook §1b), with the results appended here. Nothing in the design depends on local-only behaviour: Neon's pooler is PgBouncer in transaction mode, and the settings used (`set_config`, SECURITY DEFINER, role-scoped policies) are core Postgres. This is a confirmation step, not an open risk. It is blocked only on account access.
