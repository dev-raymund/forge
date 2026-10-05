# ADR 0001: Thin RLS through `withTenant()` on the pooled connection

| | |
|---|---|
| **Status** | Accepted for V1. Proven locally through PgBouncer in transaction mode; **Neon confirmation pending** (needs a Neon project, see below). **The tenancy module that stands on it: addendum (M3-1)** |
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

`npm run test:integration` runs `tests/integration/rls.test.ts` and the M1-6 suite `tests/integration/isolation.test.ts`: **all passing** (2026-09-30, local). Each claim below is a test that runs through the pooler:

| Claim | Test |
|---|---|
| A sees only A's rows **with no WHERE clause**, for every tenant/membership table | `isolation.test.ts` → `registered tenant reads…` (17 tables) |
| No tenant context → zero rows, inside a transaction and outside one | `rls.test.ts` → `isolation with the WHERE clause omitted` (17 tables + raw pooled query) |
| A user-only context lists that user's organizations and no tenant data | `a user-only context…` |
| Inserting or moving a row into another organization fails (`42501`, WITH CHECK) | `writes are checked too` |
| UPDATE/DELETE aimed at B's ids from A's context affect 0 rows | same block |
| Cross-site and cross-org references fail at the database (`23503`) | `composite foreign keys…` |
| 60 interleaved concurrent A / B / no-context transactions never see each other's rows | `tenant context never leaks across pooled connections` |
| Runtime role cannot bypass RLS or assume the lookup role | `runtime role` |
| Every table is classified; exactly the tenant/membership classes have RLS + FORCE; an unclassified table with `organization_id` is caught | `isolation.test.ts` → `catalog coverage` |
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

---

## Addendum (M3-1, 2026-10-05): the tenancy module

No decision above changes: shared schema, `organization_id` on every tenant row, RLS with a transaction-local context, tenant identity from the URL. This records how the module is built on it, and one policy correction.

### Who decides what

```text
modules/auth        who is this?                         session → Actor
modules/tenancy     which organization and site?         Actor + URL slugs → OrgContext / SiteContext   (context.ts)
modules/tenancy     what may they do there?              can(ctx, permission)                           (policies.ts, ADR 0009)
services            act                                  inTenant(ctx, tx => …)
Postgres            tenant boundary, whatever the code   RLS + composite foreign keys
```

- **The resolver is the only source of a tenant context.** `resolveOrgContext(actor, orgSlug)` checks, under the user's own context, that the user is a member of the organization with that slug. `resolveSiteWithin(ctx, siteSlug)` then finds the site inside that organization. `requireOrgContext` / `requireSiteContext` are the same for the current request (session + URL segment), cached per request.
- **Unknown, deleted and "not a member" are one answer: `NotFound`.** A non-member cannot tell whether a slug exists. A member of a *suspended* organization gets `Forbidden`.
- **A context cannot be made from ids.** Contexts are frozen and registered in a private `WeakSet`; `inTenant()` and every service refuse an object the resolver did not return, including a copy of a real one with another organization's id put in. So the `organization_id` RLS sees is always one whose membership was just verified.
- **No operation takes an organization id from its caller.** Services act on `ctx.org.id`. Members are named by membership id and looked up *inside the context's organization*.

### Policy correction: membership tables are read-by-member, write-in-tenant (migration 0004)

`organizations` and `organization_members` had one `FOR ALL` policy each. Its `USING` clause ("or I am a member", "or it is my own row") exists so a user can list their organizations before choosing one, but `FOR ALL` applied it to `UPDATE` and `DELETE` too.

- Found by a probe, with only a user context set: a **Viewer could delete the whole organization**, and an Owner could delete their own membership (leaving no Owner). No code did this; the database would have allowed it.
- Now: the `SELECT` policy is unchanged, and `INSERT` / `UPDATE` / `DELETE` each require `organization_id = app_current_org_id()` (for `organizations`: `id = …`). A user-only context can read the user's organizations and memberships and can change nothing.
- It also closes a quieter path: from inside organization A, a user could delete *their own* membership row of organization B (visible because it is theirs), walking around B's last-Owner rule.

RLS still knows nothing about roles. It is the tenant boundary; who may do what inside a tenant is the services' job.

### Membership rules (plan §13 "Invariants")

`membership-rules.ts` holds them as pure decisions; the services load the facts under a lock and apply them.

1. An organization always has at least one Owner.
2. Only an Owner can make an Owner, or change or remove one.
3. Managing other members takes `org.members.manage`, and handing the organization over takes `org.manage`. Which roles hold them is the catalog's answer (ADR 0009), asked of the role as re-read under the lock.
4. Anyone can leave, unless that breaks rule 1.

- **The lock.** Every membership change first locks the organization row (`SELECT … FOR UPDATE`), then reads the actor's and the target's memberships *as they are now*, then decides. Two Owners demoting each other at once: exactly one succeeds.
- **Creating an organization** is one transaction whose tenant context is the new organization's id: the organization, the creator's Owner membership and the trial subscription all commit, or none does.
- **Handing over** (`transferOwnership`) makes the target an Owner and the caller an Admin together. Several Owners may exist, so it is "promote and step down".
- **Roles are organization-wide in V1** (plan §13). `canAccessSite(ctx, site)` is the one place that says so: a member reaches every site of their organization and no other. A membership limited to some sites would change that function; the V1 schema has no such column.

### Two names for a site

- **Slug:** unique inside its organization; admin URLs (`/{orgSlug}/sites/{siteSlug}`). Resolved by the tenancy resolver, with membership.
- **Address:** unique on the platform; public URLs (`/s/{address}`). Resolved from the `domains` table with no session and no tenant context (ADR 0006).

They are different columns and different code paths. The admin resolver does not accept an address, and the public lookup never looks at who is signed in.

### What remains

- **Audit rows** for these services wait for `audit.record(tx, …)` (M3-5).
- **Permissions** beyond the four rules: delivered in M3-2, see ADR 0009. Every screen is still M3-3 and M3-4.
- **Suspending** an organization is a staff action (M12-1); here it is only honoured.
- **A deleted organization keeps its slug** (the unique constraint is not partial). Deleting organizations is not built yet; decide then whether the slug is released.

### Evidence

- `tests/integration/tenancy.test.ts` (51 tests, real Postgres as `forge_app` through PgBouncer): creation and its atomicity (a trigger makes the second or third insert fail); the resolver; every membership rule, including two concurrency cases; and the same boundaries with no service involved: reads, inserts, updates and deletes across organizations, no context, user-only context, composite foreign keys (including `domains`, which has no RLS), slug and address uniqueness, and the runtime role being unable to alter RLS.
- `tests/integration/isolation.test.ts`: the "another tenant's ids → NotFound" registry (`tests/isolation/tenant-operations.ts`), the helper deferred since M1-6. Each operation runs as A with B's identifiers and must answer `NotFound` while a digest of B's rows stays the same.
- `src/modules/tenancy/*.test.ts`, `tests/unit/reserved-slugs.test.ts`: the rules as tables; slugs; every top-level route reserved.
- `tests/e2e/tenancy.spec.ts`: on the shared origin, a signed-in Owner of one organization sees every public site exactly as a stranger does.

Mutation checks: accepting a hand-built context, dropping the organization filter on member lookups, or removing the lock each fails tests.


---

## Addendum (M3-3, 2026-10-05): the organization screens

No decision above changes. This records how the screens sit on the tenancy module, and the choices the plan left open.

### Routes

```text
/                        route handler   307 → /{org}, or /onboarding, or /login
/onboarding              page            step 1: create the organization (steps 2–3 are M4-2)
/{orgSlug}               layout + page   the organization's shell, and its home
/{orgSlug}/settings      page            name, URL, transfer ownership
```

- **The organization is the one in the URL, everywhere.** Pages read the slug from the route segment. Server Actions get it as an argument bound by the page. Either way it only says which organization is meant: `resolveOrgContext` checks the session's user against that organization's members on every request and every action. No organization id is sent by a form.
- **`/` keeps no state.** "The last organization" (plan §19) is the one the user joined most recently, among those that are not suspended, worked out from the membership rows each time (`modules/tenancy/home.ts`). There is no "current organization" in the session, a cookie or anywhere else, so two tabs on two organizations stay where their URLs say.
- **Onboarding is the first run.** A user who already has an organization is sent to it.

### How a page under `/{orgSlug}` begins

`requireOrgPage(orgSlug)` is the first line of every page and of the layout:

| Who is asking | What happens |
|---|---|
| Not signed in | Redirect to the login page, and back afterwards |
| Signed in, not a member, or no such organization | The 404 page. One answer for both |
| Member of a suspended organization | The header with the switcher, and a notice. No context is returned, so nothing of the organization is read |
| Member | The context, with the member's permissions (ADR 0009) |

- **A page checks for itself even though the layout does**, because a layout is not rendered again when the browser moves between its pages. The membership query still runs once per request (`requireOrgContext` is cached). A unit test reads the route files and fails when one does not call `requireOrgPage`.
- **A first segment that cannot be a slug** (`/favicon.ico`, `/robots.txt`) is answered as 404 before the session or the database is touched.

### Status codes: 404 and "no access" arrive as HTTP 200 for a signed-in visitor

- With Cache Components every dynamic route sends its static shell first, so the status is `200` before the membership is known. A `notFound()` after that is rendered into the page, with `noindex` (Next.js behaviour, documented under "Streaming").
- What matters for isolation holds: the page for another organization's slug is identical, status included, to the page for a slug that does not exist, and nothing of the organization's shell is rendered.
- A signed-out visitor gets a real `307` to the login page from the proxy, for any slug.
- A real `404`/`403` would need the membership check in `proxy.ts`, which means a database query there on every admin request. Not done; noted for M12-1.

### Forms

```text
form (client)  →  Server Action ("use server": session, bound slug)  →  submit…(actor, orgSlug, formData)  →  tenancy service
                   └ adds revalidatePath / refresh() / redirect()        └ modules/tenancy/organization-forms.ts
```

- **The logic is outside the `"use server"` file** so it can be run against a real database and registered in the isolation suite (`tenantForms`). The action only adds what needs a request: invalidation and the redirect.
- **Changing the URL** redirects to the new one. The old URL is a 404 at once: the optional 30-day redirect was not built (it needs a table of former slugs).
- **Transferring ownership** takes a dialog, a chosen member and the organization's slug typed out. The server checks the confirmation too, after it has checked that the caller may transfer at all.
- **Nothing per user is cached on the server.** The organization list and every organization page are rendered per request, so there is no shared cache entry to invalidate or to leak. After a change the action calls `revalidatePath` for that organization's own admin URLs and `refresh()`, which is what makes the browser's router drop its copies. A unit test fails if a caching directive appears in this code.

### What remains

- **Audit rows** for these changes (M3-5).
- **Members and invitations** (M3-4). Until then an Owner of a real organization has nobody to transfer it to.
- **Whether a user may create further organizations from a screen**, and what that means for trials (M11-1).
- **A preference cookie for the last organization used**, which the long-term architecture mentions, was not added. The rule above needs none; if one is wanted later it changes `chooseHomeOrganization` only, and must stay a hint.

### Evidence

- `tests/e2e/organizations.spec.ts` (9 browser tests): the new-user flow; the switcher, with two tabs; settings per role; rename and URL change; a member demoted or removed while the page is open; transfer between two browsers; cross-tenant 404; a suspended organization; a phone.
- `tests/integration/organization-forms.test.ts` (26, real Postgres): every form through its `submit…` function, including what it refuses and where it may send the browser.
- `tests/integration/isolation.test.ts`: each form given another organization's slug or member is refused as `NotFound`, redirects nowhere, and leaves that organization unchanged; asked by a Viewer, it answers the same as for something that does not exist.
- `src/modules/tenancy/home.test.ts`, `ui/ui.test.tsx`, `tests/unit/organization-pages.test.ts`: the `/` rule; what the settings page shows for each combination of permissions; the two source-level rules above.
