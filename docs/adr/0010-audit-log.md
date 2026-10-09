# ADR 0010: The audit log has one writer, inside the change's own transaction

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-07 |
| **Issue** | M3-5 (v1-github-issues.md) |
| **Decisions touched** | D-30 (audit log in the business transaction, append-only by grants); builds on ADR 0001 (RLS, `withTenant`), ADR 0009 (`org.activity.read`) and ADR 0004 (account events) |

## Context

D-30 decided what the audit log is: written in the same transaction as the change it describes, and append-only for the application's database role. The `audit_logs` table, its RLS policy and its grants (INSERT and SELECT only) have existed since M1-1. M2-4 added `recordPlatformEvent()` for account events.

What was missing was the writer for tenant activity and anything to read it with. By the end of M3-4 eleven kinds of change (an organization created, renamed, moved, handed over; members invited, changed, removed, leaving; invitations re-sent, revoked, accepted) left no record. This ADR records how they got one, and the page that shows it. No table or grant changed.

## Decision

### 1. One writer

```ts
record(tx, { action, resourceType, resourceId, metadata }, request?)   // modules/audit/record.ts
```

- **It takes the transaction of the change.** The service that makes the change calls it, with the transaction it is already in. The change and its record commit together, or neither does.
- **Who did it, and in which organization, are not parameters.** The INSERT reads them from the transaction's own context: `app_current_org_id()` and `app_current_user_id()`, the values `withTenant` set and that row-level security already answers to. The actor's address is looked up by that id, as a snapshot. A service cannot record an event for another organization or in somebody else's name, even by mistake: there is nothing to pass.
- **Without that context it writes nothing and throws.** There is no organization-less tenant event.
- **`request`** is the request's id and client address (`OrgContext` has both). They are stored for support and security work.
- **Only the audit module touches the table.** A unit test reads the source and fails if any other module names `audit_logs`.

### 2. The vocabulary

`modules/audit/events.ts` is the list of events. Each has a name (`resource.verb`, past tense), the kind of thing it is about, and a schema of the details that may be stored with it.

| Event | About | Details stored |
|---|---|---|
| `organization.created` | organization | `name`, `slug` |
| `organization.updated` | organization | `previousName` + `newName`, and/or `previousSlug` + `newSlug` |
| `organization.ownership_transferred` | organization | `newOwnerName` |
| `member.invited` | invitation | `email`, `role` |
| `invitation.resent` | invitation | `email` |
| `invitation.revoked` | invitation | `email` |
| `invitation.accepted` | invitation | `role`, `alreadyMember` when the person had joined another way |
| `member.role_changed` | membership | `memberName`, `previousRole`, `newRole` |
| `member.removed` | membership | `memberName`, `role` |
| `member.left` | membership | `role` |

- **The writer accepts nothing that is not in the list**, and stores no detail the event's schema does not name. A missing or malformed detail throws.
- **Metadata says what changed. It is never a copy of a row.** Besides the schemas, any key named like a secret (`token`, `hash`, `password`, `secret`, `session`, `cookie`, `apiKey`, …) is dropped before anything is stored. An invitation's token, hash and link are never in a record.
- **A change that changes nothing is not an event.** Saving the same name, or giving a member the role they have, writes no row.
- **A refused attempt is not an event** in V1.
- **To add an event**, add it to the list and call `record` in the service. Nothing else about the architecture changes.

### 3. If the record cannot be written, the change is not made

`record` throws inside the caller's transaction, and the transaction is lost with it. This is D-30's stated tradeoff, and it is the opposite of the rule for email: an email is an outside effect that must never undo a change; an audit record is part of the change.

The user sees the generic "something went wrong" with the request id. Nothing was committed.

### 4. What is not in a Forge transaction

Account events (`auth.login`, `auth.logout`, `auth.password_changed`) happen inside Better Auth's own queries. `recordPlatformEvent()` writes them afterwards, standalone, as D-30 says ("Authentication events are standalone"). They have no organization, and no tenant query can read them: the table's policy needs one. Reading them is the staff console's job (M12-1).

### 5. Reading: the activity page

`/{orgSlug}/activity`, for members who hold `org.activity.read` (Owner and Admin).

```text
page → listActivity(ctx, query)        modules/tenancy: requirePermission(ctx, "org.activity.read"), inTenant
         → queryActivity(tx, orgId, …)  modules/audit: the rows
```

- **The permission is checked in the query's own function**, not only by the page.
- **The organization is the context's.** The query states `organization_id = …` as well as relying on RLS, so a row that belongs to no organization can never be on the page.
- **Each line is a sentence** built from the stored event (`describeEvent`): "Raymund changed Jane's role from Author to Editor." An event this code does not know is listed by its name, not hidden.
- **Stored is not shown.** The client address and request id are kept for security work. The query behind the page does not select them, or any id of a user.
- **Filters:** event, who did it, from day, to day. They are a GET form: the list is what the URL says. Every value is untrusted and either reduced to something well-formed or dropped. "Who" is a membership id, resolved to a user inside the organization; one that is not this organization's matches nobody.
- **Pages:** 25 events, newest first, then a cursor. The order is `created_at DESC, id DESC`, served by the existing index `(organization_id, created_at DESC)`. The cursor carries the last event's time in whole microseconds, as text: a JavaScript date keeps milliseconds, and a cursor rounded to those skipped events written in the same millisecond.
- **Nothing is cached.** The page is rendered per request. Every action that records an event also refreshes the organization's activity URL in the browser's router.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| The actor and organization come from the transaction's context, in SQL | It is the same context RLS enforces, so the record cannot disagree with what was allowed; and the API has nothing to forge | `record` only works inside `withTenant({ orgId, userId })`. A job or an API key needs its own way in | System and API-key actors are needed (M7-2, M10-1): add them as explicit, typed callers, not as free parameters |
| An audit failure fails the change | D-30: a change to who may do what, with no record, is worse than a failed one | An outage of the log is an outage of every recorded action | Never for security-relevant events |
| A typed vocabulary with a schema per event | Nothing unplanned is stored; secrets cannot ride along; the page can describe every event | Each new event is a line in the list and a sentence | — |
| The permission check lives in the tenancy module, the rows in the audit module | Every module will write audit events, so the audit module must depend on none of them | Reading activity is two functions in two modules | — |
| Keyset pages, no page numbers, no sort options | Stable while new events arrive, and one index serves it | No "jump to page 7", no sorting by actor | An export or search feature is built |
| Days in filters are UTC days | One meaning for everyone, no time-zone parameter to trust | A day boundary is not the viewer's midnight | Users ask |
| The filter by person lists current members | No scan of the whole log for everyone who ever acted | A former member's events are listed, but cannot be filtered for | The list is needed |

## Not in V1

Export, analytics, a real-time feed, webhooks, anomaly detection, a retention UI or purge (`audit_purge_before()` in the long-term design is not built, so nothing is ever deleted), cross-organization views, and the platform's own audit console (M12-1). The `user_agent` column of the long-term design is not in the V1 table.

Actor types stay as the V1 table has them (`user`, `api_key`, `system`). Every M3 event is a user's.

## Evidence

- `tests/integration/audit.test.ts` (34, real Postgres as `forge_app` through PgBouncer):
  - each of the eleven changes writes its row, with the right actor, organization, resource and details;
  - a transaction that fails after the record was written leaves neither (a deferred trigger refuses the commit);
  - with inserts into `audit_logs` refused, each of the eleven changes throws and nothing is committed, including the invitation email;
  - the writer refuses to run outside an organization's transaction, and cannot be told an organization or an actor;
  - UPDATE, DELETE and TRUNCATE are refused to the application's role in every context;
  - the activity query: permission, isolation, platform events excluded, filters, pages (60 events; twelve in one instant; six inside one millisecond), and its plan uses the index without a sort;
  - the M3-1 and M3-4 concurrency cases, each leaving exactly one record.
- `tests/integration/isolation.test.ts`: the activity read is in the tenant-reads registry; filters naming another organization's member or site show none of its events; `audit_logs` is among the rows of the other organization that no check may change.
- `src/modules/audit/*.test.ts`, `ui/ui.test.tsx`: the vocabulary, sanitization, sentences, URL parsing, the cursor, the page's markup.
- `tests/unit/audit-writer.test.ts`: only the audit module names the table; each service records its events with its own transaction; the activity query selects no address, request id or user id.
- `tests/e2e/activity.spec.ts` (6): creation, rename and URL change; invite → accept → role change → remove, with filters; ownership transfer and who may read; another organization's log; pages; a phone.

---

## Addendum (M4-1, 2026-10-08): site events, and the site an event belongs to

- **Three events** join the vocabulary, about a `site`: `site.created` (`name`, `address`), `site.address_changed` (`name`, `previousAddress`, `newAddress`), `site.deleted` (`name`, `address`). The site's name is stored with each, so the line still reads after the site is renamed or deleted. Written by `modules/sites/sites.service.ts`, in the transaction of the change (ADR 0011).
- **`record` takes an optional `siteId`**, as M3-5 left for it. It is checked like the organization and the actor: inside the INSERT, it must be a site of the transaction's own organization (RLS hides every other), or nothing is written and `record` throws. A site of another organization cannot be named, even by mistake.
- **The activity page's site filter** now has its drop-down, listing the organization's sites. A deleted site's events are still in the log, but its name is no longer in the list, the same rule as former members.
- **Evidence:** `tests/integration/audit.test.ts` ("every event is covered by a mutation", "a site-level event can only name a site of the transaction's organization"); `tests/integration/sites.test.ts` (each site event, its failure leaving no change, the filter).

---

## Addendum (M4-4, 2026-10-09): the theme switch

- **`site.theme_changed`** (about a `site`; `name`, `previousTheme`, `newTheme`, as theme keys) is written by `modules/sites/appearance.service.ts` in the transaction that changes `sites.theme_key` (ADR 0012). Choosing the theme a site already has records nothing.
- A stored key that is not a theme any more is recorded as its letters, digits and hyphens, so that the record can be written and the site can still be moved to a real theme.
