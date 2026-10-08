# ADR 0011: Sites: one transaction, a global address, a plan limit

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-08 |
| **Issue** | M4-1 (v1-github-issues.md) |
| **Decisions touched** | D-04 (composite keys), D-08 (tenant from the URL), D-10 (plan limits in code), D-27 (cache tags), D-30 (audit); builds on ADR 0001 (RLS), ADR 0006 (`/s/{address}`), ADR 0009 (`sites.create`, `sites.delete`, `site.settings.manage`), ADR 0010 (the audit writer) |

## Context

The tables a site needs (`sites`, `site_settings`, `domains`) have existed since M1-1, with their constraints, RLS and composite foreign keys. M3-1 added the read side the tenant resolver needs. Nothing could create a site, and nothing checked a plan's limit.

M4-1 adds creating a site, listing an organization's sites, moving a site to another address and deleting one, the pages for them, and the first plan limit. No table, column, constraint, grant or policy changed: there is no migration.

## Decision

### 1. Creating a site is one transaction

```text
createSite(ctx, input)                          modules/sites/sites.service.ts
  requirePermission(ctx, "sites.create")        the role (ADR 0009)
  inTenant(ctx, tx =>                           the organization from the URL, as RLS sees it
    assertLimit(tx, org, "sites")               the plan: locks the organization's row, then counts
    parse the input                             the shared schema
    choose the slug                             under the lock
    insert sites, site_settings, domains        the site, its settings, its address
    record(tx, "site.created")                  the audit row (ADR 0010)
  )
  → the site, and its cache events
```

- **All of it or none of it.** If any insert, the record, or the commit fails, nothing remains: no site, no settings, no address held back, no line in the log.
- **The order of the questions** is ADR 0009's: may this person (the role), may this organization (the plan), is the input acceptable, then write. Someone who may not create sites is told that, not that the plan is full, and nothing they sent is looked at.
- **The organization is the context's.** The form has no organization, site, owner, status or theme field the service reads; extra fields are ignored.
- **What is created:** the `sites` row (`coming_soon`, the table's default theme, the chosen language and time zone, `created_by`), one `site_settings` row whose JSONB groups are empty (their readers apply the defaults, M4-2), and the address. Nothing else: no menus, no SEO rows, no pages. The plan's Home page draft needs entries, which do not exist yet (M5-3).

### 2. The address

- **Stored where ADR 0006 put it:** the `hostname` of the site's `domains` row of kind `subdomain`, primary and `active` from the start (there is nothing to verify). Not a column of `sites`.
- **Unique on the whole platform** by the table's unique constraint on `hostname`. That constraint is the only judge. Nothing checks availability first; two requests for one address both reach the insert, one commits, and the other's unique violation becomes "That address is already taken" at the field. Tested with ten organizations at once.
- **One spelling:** trimmed and lowercased before anything else, so `Acme` and `acme` are one address. The table's CHECK already refuses capitals.
- **Shape:** `isSiteAddress`, the rule the router already applied to `/s/{address}`: a DNS label of 1 to 63 lowercase ASCII letters, digits and single hyphens, not at either end. No second algorithm.
- **No conversion of other alphabets.** Letters outside ASCII are refused, not turned into punycode, and a double hyphen is refused, which also refuses punycode typed in (`xn--…`). No address can be made to look like another.
- **Reserved:** `www`, `app`, `api`, `admin`, `media`: labels the platform keeps for itself under the sites domain, where addresses become hostnames (post-V1).
- **Not reserved: the app's own paths.** An address only ever appears after `/s/`, and the proxy routes `/s/…` before anything else, so a site called `login` lives at `/s/login` and `/login` is still the login page. A unit test walks every top-level route of the app and checks both halves, instead of keeping a list of words.

### 3. The slug

A site's slug (admin URLs, unique inside its organization) is not asked for. It is the address the site is created with, which already has the shape of a slug. If an older site of the organization holds it (its address changed since), or it is `new` (the create page, `/{orgSlug}/sites/new`), a number is added: `acme-2`. It never changes afterwards: moving a site to another address keeps its admin URLs.

### 4. The plan limit

```ts
assertLimit(tx, organizationId, "sites")   // modules/billing/limits.ts
```

- **Plans in code** (`modules/billing/plans.ts`, D-10): Free 1 site, Pro and the Pro trial 5, the plan's figures. Only the sites limit exists; the others arrive with what they limit (M11).
- **Which plan:** the organization's `subscriptions.plan_key`. Organization creation writes the trial (`pro`); M11's webhook and trial job will change it. No row means Free. Nothing about Stripe is needed.
- **Race-free:** it locks the organization's row (`FOR UPDATE`) and then counts, in the transaction that creates the site. Creations in one organization take turns, so ten at once on a Free plan make exactly one site.
- **A deleted site does not count.**
- **Kept apart from the role.** The role says whether this person may create sites; the plan says whether the organization may have another. Two functions, asked in that order.

### 5. Moving and deleting

- **`changeSiteAddress`** (`site.settings.manage`: Owner, Admin) updates the `subdomain` row. The old address stops answering and is free for anyone at once; nothing redirects from it. The same address again changes and records nothing.
- **`deleteSite`** (`sites.delete`: Owner) is a soft delete: `deleted_at` is set and the rows stay. Its `domains` rows are deleted (plan §11: a deleted site's domains go first), so its address answers "not found" and is free for anyone from the commit. Its slug is free too (the unique index skips deleted sites). It no longer counts towards the limit. The form asks for the address typed out. There is no restore in V1.
- Both are recorded in the same transaction: `site.address_changed`, `site.deleted`.

### 6. The public address after a change

`/s/{address}` is resolved by the renderer (`resolveSite(locator)`, M0-4, rebuilt in M4-3) from the `domains` row alone, with no session or tenant context: the proxy strips cookies from `/s/*` (ADR 0006), and the function's only input is the locator. Its result, including "no such site", is cached under `host:{address}`.

So every change that affects an address names it: creating (the new address may have been asked for before it existed), moving (old and new), deleting. The service returns `domain.changed` events; the Server Action flushes them after the commit with `updateTag` (`host:{address}` and `site:{id}`, D-27). Site-scoped tags only; nothing global.

The admin pages are not cached at all. The action also refreshes the browser's router for the organization's pages and the site's.

### 7. Routes

| Route | What | Who |
|---|---|---|
| `/{orgSlug}` | A redirect (307) to `/{orgSlug}/sites`, as plan §19 says. A route handler that looks nothing up: the same answer for every organization and visitor | anyone |
| `/{orgSlug}/sites` | The sites, and the organization's home: `/`, onboarding and every in-app link land here | every member |
| `/{orgSlug}/sites/new` | The create-site form: name, address, language, time zone (plan §3) | `sites.create` |
| `/{orgSlug}/sites/{siteSlug}` | The site's page: status, public address, language, time zone. The overview proper is M4-2 | every member |
| `/{orgSlug}/sites/{siteSlug}/settings` | Its address (plan §19: "in site settings until M9") and deleting it. M4-2 adds the general, reading and analytics groups | Owner, Admin |

A site of another organization, by slug or by id, is the 404 page, exactly like a site that does not exist.

### 8. Languages and time zones

The language is a BCP 47 subtag from a list in code (`modules/sites/locale.ts`), stored in `sites.default_locale`. Languages written right to left are left out until a theme lays them out. The time zone is any IANA zone the runtime knows (`Intl.supportedValuesOf`), UTC first; the form starts at the browser's own.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| The database's unique constraint decides whether an address is free | It is the only answer that holds under concurrency | No live "available?" hint while typing | A hint is wanted (it would still be only a hint) |
| The slug is the address at creation, and never changes | No second field to fill in; admin links survive a move | Slug and address can differ after a move | People ask to rename the slug |
| No list of app paths among reserved addresses | Under `/s/` they cannot collide; a test proves it from the routes that exist | Someone can name a site `login` (`/s/login`) | Sites move to their own hostnames and share a namespace with platform hosts: grow the reserved list then |
| A deleted or moved address is free at once | What the plan says for domains; the owner can reuse it | Old links may lead to someone else's site | Squatting or impersonation is seen: hold addresses for a period |
| `assertLimit` locks the organization's row | Counting without a lock lets two requests take the last place | Creations in one organization queue for a moment | Never for V1 volumes |
| Plan = `plan_key`, no row = Free | Works with no billing account; M11 changes one function | A trial past its end keeps Pro limits until M11's job runs | M11-1 |

## Not in V1 (or not in M4-1)

Custom domains, DNS verification, wildcard subdomains and the Vercel domains API (ADR 0006, M9); a site restore; a live availability check; renaming a site and its other settings (M4-2); the coming-soon page and unknown/suspended site pages (M4-3); the Home page draft (M5-3).

## Evidence

- `tests/integration/sites.test.ts` (real Postgres as `forge_app` through PgBouncer): creation and every row it writes; the role table; invalid, reserved, taken and differently spelled addresses; the slug's number; the record failing, the address failing, and the commit refused after everything was written, each leaving nothing; the Free and Pro limits, deleted sites not counting, no subscription row; ten at once on Free and four at once for Pro's last place; ten organizations racing for one address; moving and deleting, with their records and refusals; the forms; isolation; the activity filter by site; the public resolver after create, move and delete.
- `tests/integration/isolation.test.ts`: the site forms with another organization's slugs and sites, the sites list in the reads registry, and `domains` in the fingerprint of what must not change.
- `tests/integration/audit.test.ts`: every event, the site ones included, is written by some mutation; a site-level event cannot name another organization's site.
- `src/modules/sites/*.test.ts`, `src/modules/billing/plans.test.ts`, `tests/unit/site-addresses.test.ts`: the address and slug rules, languages and time zones, the plans, the proof that no address can take an app path, and that the sites area's own pages are reserved slugs.
- `tests/e2e/sites.spec.ts`: create → list → public site; the same public site for everyone; a taken address; an Editor; another organization's site; move and delete; the Free limit; a phone.
