# ADR 0009: Authorization is a permission catalog in code, asked through `can()`

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-05 |
| **Issue** | M3-2 (v1-github-issues.md) |
| **Decisions touched** | D-09 (RBAC model), D-10 (entitlements are a separate axis), D-08 (tenant from the URL); builds on ADR 0001 (RLS, the tenancy module) and ADR 0006 (one origin) |

## Context

After M3-1 the application knows who a request is from (`modules/auth`) and which organization and site it is about (`modules/tenancy`, the resolver). It did not yet have one place that says what that member may do. The two checks that existed were comparisons of a role inside the tenancy module (`role === "owner"`, a list of two roles).

Plan §13 fixes the V1 model: five roles, one per member, organization-wide, with a table of permissions per role. This ADR records how that table became code, and the rules for using it. Nothing in the tenancy architecture changes.

## Decision

### 1. Three layers, three questions

```text
RBAC       modules/tenancy/permissions.ts   what does this role hold?             role → permissions (data)
Policies   modules/<m>/policies.ts          may this caller attempt this?         can(ctx, permission, resource?)
RLS        Postgres                         is this row in the caller's tenant?   whatever the code above did
```

None stands in for another.

- **RLS knows nothing about roles.** It is the tenant boundary. A Viewer and an Owner of the same organization see the same rows.
- **Permissions are not checked in SQL or in triggers.** They are checked in the service, before it does anything.
- **What the UI shows is not authorization.** A screen may hide a button with `can()`. The service still checks.

A fourth question, "does this organization's plan include it?", is **entitlements** (D-10, M11-1). It is a separate axis: the catalog has no plan or billing-state keys, and a role never grants a feature the plan lacks. `org.billing.manage` is the permission to manage billing, not a statement about the plan.

### 2. The catalog

`src/modules/tenancy/permissions.ts` holds every permission as a typed list (`PERMISSIONS`, type `Permission`). Keys are `area.action`. Entry keys carry the content type: `entries.{type}.{action}`. A key ending in `.own` covers what the member made; its `.any` twin covers everyone's.

The vocabulary is plan §13's, written out one key per row. The plan's shorthand rows expand like this:

| Plan §13 row | Keys |
|---|---|
| `entries.page.*` | `entries.page.create`, `.update`, `.publish`, `.delete` |
| `entries.*.read` | `entries.page.read`, `entries.post.read` |
| `entries.post.create`, `.update.own`, … | `entries.post.create`, `entries.post.update.own`, `entries.post.publish.own`, `entries.post.delete.own` |
| `site.menus.manage`, `site.seo.manage` | two keys |
| `terms.manage` / `terms.assign` | two keys |
| `media.upload`, `media.update.own`, … | `media.upload`, `media.update.own`, `media.delete.own` |

That is 29 keys. Three things the catalog deliberately does not have:

- **No read keys for the organization, its member list or its sites.** Being a member is what grants those reads. The resolver answers `NotFound` to everyone else.
- **No platform-staff keys.** Staff access is a different mechanism (M12-1) and is never a role of an organization.
- **No keys for things V1 does not build.**

**One wildcard.** A role may be given `entries.*.{action}`: that action on every entry type. `*` stands for the type segment only. It never spans segments (`entries.*.update` does not cover `entries.post.update.own`) and means nothing anywhere else (`org.*`, `media.*` and `*` cover nothing). V1 uses it once, for `entries.*.read`. Wildcards exist only in what a role is given. They are expanded against the catalog when the module loads, so a permission set contains catalog keys and nothing else, and a wildcard is never a permission that can be asked for.

### 3. Role → permissions

`ROLE_GRANTS` in the same file is the one mapping. `permissionsForRole(role)` returns the role's set: the same immutable object every time, for every organization.

This table is checked against the code by a unit test (`permissions.test.ts`), so the two cannot drift apart.

<!-- matrix:start -->
| Permission | Owner | Admin | Editor | Author | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| `org.manage` | ✓ | | | | |
| `org.billing.manage` | ✓ | | | | |
| `org.members.manage` | ✓ | ✓ | | | |
| `org.activity.read` | ✓ | ✓ | | | |
| `sites.create` | ✓ | ✓ | | | |
| `sites.delete` | ✓ | | | | |
| `site.settings.manage` | ✓ | ✓ | | | |
| `site.menus.manage` | ✓ | ✓ | ✓ | | |
| `site.seo.manage` | ✓ | ✓ | ✓ | | |
| `entries.page.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `entries.page.create` | ✓ | ✓ | ✓ | | |
| `entries.page.update` | ✓ | ✓ | ✓ | | |
| `entries.page.publish` | ✓ | ✓ | ✓ | | |
| `entries.page.delete` | ✓ | ✓ | ✓ | | |
| `entries.post.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `entries.post.create` | ✓ | ✓ | ✓ | ✓ | |
| `entries.post.update.own` | ✓ | ✓ | ✓ | ✓ | |
| `entries.post.update.any` | ✓ | ✓ | ✓ | | |
| `entries.post.publish.own` | ✓ | ✓ | ✓ | ✓ | |
| `entries.post.publish.any` | ✓ | ✓ | ✓ | | |
| `entries.post.delete.own` | ✓ | ✓ | ✓ | ✓ | |
| `entries.post.delete.any` | ✓ | ✓ | ✓ | | |
| `terms.manage` | ✓ | ✓ | ✓ | | |
| `terms.assign` | ✓ | ✓ | ✓ | ✓ | |
| `media.upload` | ✓ | ✓ | ✓ | ✓ | |
| `media.update.own` | ✓ | ✓ | ✓ | ✓ | |
| `media.update.any` | ✓ | ✓ | ✓ | | |
| `media.delete.own` | ✓ | ✓ | ✓ | ✓ | |
| `media.delete.any` | ✓ | ✓ | ✓ | | |
<!-- matrix:end -->

Owner 29, Admin 26, Editor 22, Author 10, Viewer 2.

**An unknown role holds nothing.** That covers a key the code does not know, and a `roles` row that is not one of the five system rows (one that belongs to an organization), whatever its key says. The repository treats a membership with such a role as no membership, so its user gets `NotFound`. The application's database role has `SELECT` only on `roles`.

### 4. `can()` and `requirePermission()`

Both live in `modules/tenancy/policies.ts` and are exported from `@/modules/tenancy`.

```ts
can(ctx, permission, resource?): boolean      // never throws
requirePermission(ctx, permission, resource?) // returns, or throws Forbidden (403)
canActOn(ctx, scope, resource): boolean       // "anyone's, or their own": scope.any || scope.own
```

`can()` answers yes only when all of these hold:

1. `ctx` is a context the resolver returned. Anything else (nothing, a hand-built object, a copy of a real context with other permissions put in) is allowed nothing.
2. The context's permission set holds the key. A key that is not in the catalog is held by nobody.
3. If a `resource` is given, it belongs to the context's organization. A resource of another organization is refused whatever the key.
4. If the key ends in `.own`, a resource is given and its `ownerId` is the caller's user id. No resource, or a resource with no recorded owner, is not the caller's own.

A resource is `{ organizationId, ownerId }`. The module that owns the row says which column is the owner: `author_id` for an entry, `uploaded_by` for a media item.

`requirePermission()` is the form services use. Given something that is not a genuine context it throws a plain error (a fault in the calling code, HTTP 500), not `Forbidden`: nothing is allowed either way.

### 5. Where a member's permissions come from

```text
session → Actor → membership row of the organization in the URL → role → permissionsForRole(role) → ctx.permissions
```

- The resolver (`resolveOrgContext`) reads the membership and puts the role's set into the context it seals. `ctx.permissions` is a `PermissionSet`: `has(key)` and a frozen `list`. There is no way to add to one.
- **Nothing the request carries is read**: no body field, header, cookie, query parameter or client state. There is no "active organization" in the session.
- **Once per request, never cached across requests.** `requireOrgContext` is wrapped in React `cache()`, so one request does one membership query. A role change therefore counts from the member's next request. No Redis, no cache to invalidate.
- **No context, no permissions.** A visitor who is not signed in gets `Unauthenticated`; a user who is not a member gets `NotFound`; a member of a suspended organization gets `Forbidden` for every role. Public site rendering (`/s/{address}`) never builds a context at all (ADR 0006).

### 6. Policies, business rules and the order of checks

A **policy** says whether the caller may attempt something. A **business rule** says whether the resulting state is valid. Both stay, in different places:

| | Question | Where | Refusal |
|---|---|---|---|
| Policy | May this member attempt it? | `policies.ts`, from the catalog | `Forbidden` (403) |
| Business rule | Would the result be valid? | the service and its pure rules (`membership-rules.ts`) | usually `Conflict` (409) |

The membership rules show the difference. `org.members.manage` lets an Admin attempt to change a member. Two rules that are not permissions still decide: an organization always keeps an Owner (409 even for the Owner, who holds every permission), and only an Owner can make, change or remove an Owner. No change to the catalog can relax them.

Order inside a service, as in the long-term architecture (§11.5):

```text
authenticate → resolve the tenant → policy → entitlement → validate input → business rules
```

- **Outside the tenant: `NotFound`.** The resolver, and every lookup scoped to `ctx.org.id`.
- **Inside without the permission: `Forbidden`.** The policy runs before the input is read, so a member without the permission gets the same `Forbidden` whatever id they name. The answer says nothing about what exists.
- A member *with* the permission who names another organization's row gets `NotFound`, identical to a row that does not exist.

### 7. Membership changes are checked twice

```text
1. requirePermission(ctx, …)           on the request's context, before anything is read or locked
2. lock the organization → re-read the actor's role → roleHolds(role, …) + the membership rules
```

The first keeps members without the permission away from the organization lock. The second closes the gap between the start of a request and its transaction: a member demoted in between is refused, because the role is read again under the lock. Both ask the same catalog.

### 8. A lint rule keeps role comparisons in one module

Outside `src/modules/tenancy`, comparing a role with one of the five role names (`member.role === "owner"`, a `switch` on a role) fails ESLint with a message pointing at `can()`. Inside the module one comparison remains on purpose: the rule that names the Owner role.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Permissions and the role mapping are code, not rows | Typed keys, one diff to review, nothing to migrate or cache; a typo does not compile | Changing what a role may do is a deploy | Custom roles are built: their grants become rows, expanded through the same `grantMatches` |
| One role per member, organization-wide | Plan §13; one membership query answers everything | A member cannot be an Editor of one site and a Viewer of another | Site-level roles are wanted: `canAccessSite` and the resolver are the two places to change |
| The policy runs before input is validated | An unprivileged member learns nothing from their own input, and never takes the organization lock | They get 403 where a malformed request used to get 422 or 404 | Never, as far as we can see |
| `can()` refuses a resource of another organization | A second net under RLS, for the user who belongs to two organizations | Every resource passed to a policy must carry its `organizationId` | Never |
| Permissions are worked out per request, no cache | Demotions and removals count on the next request with nothing to invalidate | One indexed membership query per admin request | That query shows up in profiles |
| An unknown role is "not a member" (404), not "a member with nothing" | One answer for everything unrecognised; no half-member state to reason about | A bad `roles` row locks its members out until fixed | Custom roles are built |

## Not in V1

Custom roles, site-specific roles, per-record or per-user permissions, teams or groups, role inheritance, and platform-staff permissions. None is needed by the plan, and none is blocked: the catalog, the wildcard rule and `can(ctx, permission, resource?)` are the shapes D-09 describes.

## Evidence

- `src/modules/tenancy/permissions.test.ts`: the catalog is plan §13's 29 keys; a generated matrix, every role × every key, against a table written by hand in the test; the table above against the code; unknown roles and unknown keys; the wildcard rule; ownership and cross-organization decisions.
- `src/modules/tenancy/policies.test.ts`: `can()`, `requirePermission()` and the policies on contexts built by the real resolver; forged contexts; headers and extra fields that claim a role.
- `tests/integration/permissions.test.ts` (real Postgres, as `forge_app` through PgBouncer): each role's context; the services allow exactly what the catalog says; role changes count from the next request and under the lock, including two Admins demoting each other at once; no self-escalation; a made-up `roles` row gives nothing; 404 against 403; a user in two organizations; a suspended organization; the public lookup has no permissions.
- `tests/integration/isolation.test.ts`: every registered operation run as a Viewer answers the same for another tenant's identifiers as for identifiers that do not exist; policies handed another tenant's resource allow nothing.
- `tests/unit/lint-boundaries.test.ts`: the lint rule.
- `tests/e2e/tenancy.spec.ts`: for a member of each role, the public site is a stranger's view, and neither the session nor any cookie carries a role, a permission or an organization.

## Consequences

- Every later service starts with `requirePermission(ctx, …)` or a policy from its module's `policies.ts`, and registers the policy in `tests/isolation/tenant-operations.ts`.
- Content and media policies are one line each on `canActOn` (M5-3, M6-1).
- The organization and member screens (M3-3, M3-4) use the three tenancy policies to decide what to show, and add browser tests for what each role sees.
- Plan limits and the trial (M11-1) are checked after the policy and before validation, by their own module.

---

## Addendum (M3-3, 2026-10-05): who may open the organization's settings

The catalog has keys for changing things and none for looking at a settings page. Plan §13 says "only Owner/Admin see settings"; plan §19 lists `/{org}/settings` under "Owner".

| | |
|---|---|
| **Decision** | `canViewOrganizationSettings(ctx)` = the member holds `org.manage` or `org.members.manage`. In V1 that is Owner and Admin. An Admin sees the name and URL read-only; the forms on the page are each their own permission (`org.manage`: Owner). Editors, Authors and Viewers get a "no access" page |
| **Reason** | It is the §13 rule, written with keys that exist. Adding a key (`org.settings.read`) would have changed the approved catalog for one page |
| **Tradeoff** | The entry rule is derived, not a key of its own, so it cannot be granted separately. An Admin opens a page on which they can change nothing until member and activity links join it (M3-4, M3-5) |
| **Reconsider when** | The owner wants the page Owner-only (one line in `policies.ts`), or custom roles need to grant "view settings" by itself |

Two things the screens made concrete:

- **A screen shows; an action decides.** The settings page renders forms from booleans (`canUpdate`, `canTransfer`) and is never told a role. Each action resolves the context and asks again. A browser test demotes an Owner while the page is open and submits the form that is still on screen: the server refuses.
- **The order holds for forms too.** The transfer form checks `org.manage` before it reads the chosen member or the typed confirmation, so a member who may not transfer gets the same `Forbidden` whatever they send.

---

## Addendum (M3-4, 2026-10-07): members and invitations

No key was added. What the members page and invitations take:

| Action | Takes | Also |
|---|---|---|
| See the member list | membership | |
| See pending invitations | `org.members.manage` | |
| Invite, re-send | `org.members.manage` | a verified email of the caller's own (plan §12); the role must be assignable |
| Revoke an invitation | `org.members.manage` | |
| Change a role, remove a member | `org.members.manage` | the membership rules (an Admin cannot touch an Owner; an Owner always remains) |
| Leave | membership | the last Owner cannot |
| Accept an invitation | nothing: the caller is not a member yet | a valid link, and an account with the invited address |

- **Assignable roles** are Admin, Editor, Author and Viewer (`ASSIGNABLE_ROLES`). They are what an invitation can carry and what the role form accepts. Owner is not among them, for an Owner either: that is the transfer in the settings.
- **A verified email is not a permission.** It is a condition on one action, checked after the permission. An Editor with a verified email still cannot invite.
- **The order holds.** A member without `org.members.manage` gets the same `Forbidden` whatever member, invitation, address or role they name.

---

## Addendum (M3-5, 2026-10-07): the activity log

`org.activity.read` (Owner and Admin) now has its use: `listActivity(ctx, …)` starts with `requirePermission(ctx, "org.activity.read")`, and the page and the organization's links use `canReadActivity(ctx)`. No key was added. Editors, Authors and Viewers get the "no access" page and no link. See ADR 0010.
