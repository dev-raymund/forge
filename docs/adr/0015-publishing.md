# ADR 0015: Publishing a site, and analytics scripts deferred

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-10 |
| **Issue** | M4-5 (v1-github-issues.md) |
| **Decisions touched** | D-27 (cache tags), D-30 (audit); builds on ADR 0006 (one origin, `/s/{address}`), ADR 0009 (`site.settings.manage`), ADR 0010 (audit writer), ADR 0011 (sites), ADR 0013 (renderer), ADR 0014 (overview, analytics settings). Amends ADR 0014 §3 and the M4-2 addendum of ADR 0006. |

## Context

Since M1-1 `sites.status` is `coming_soon`, `live` or `suspended`; every new site is `coming_soon` (ADR 0011). The renderer has drawn each status since M4-3 (ADR 0013 §2): a coming-soon site is the theme's Coming soon page at every path, `noindex, nofollow`; a live site is its home page at `/`, `index, follow`. Nothing could change the status.

M4-5 adds the switch. No table, column, status value or constraint changed: there is no migration.

## Decision

### 1. The transition

| From | To | Result |
|---|---|---|
| `coming_soon` | `live` | published (needs a verified email address) |
| `live` | `coming_soon` | back to Coming soon |
| `coming_soon` or `live` | the same | nothing: no write, no record, no flush |
| `suspended` | anything | refused (Conflict): only staff lift a suspension (M12-1) |
| anything | `suspended` | not possible: the request's schema has no such value |

The issue's criterion is `coming_soon ↔ live`, so both directions are built. The M4-5 instructions say not to build unpublishing "unless explicitly required by M4-5"; the issue requires it. The table is `statusTransition` (`modules/sites/publishing.ts`, pure).

### 2. The operation

```text
setSiteStatusAction(orgSlug, siteSlug)        Server Action: slugs bound by the overview from its URL
  → submitSetSiteStatus(actor, …, formData)   reads `status` and nothing else
  → resolveSiteContext                        the session's user, a member of that organization, a site of it
  → setSiteStatus(ctx, { status })            modules/sites/publishing.service.ts
      requirePermission(ctx, "site.settings.manage")     Owner, Admin (plan §13: "… publish site")
      setSiteStatusSchema: "coming_soon" | "live"
      to live: ctx.actor.emailVerified, or Forbidden "Verify your email address to publish this site."
      inTenant:
        select status … for update            the site's row, locked until commit
        statusTransition(current, target)
        update sites set status
        record("site.status_changed", { name, previousStatus, newStatus })
  → commit → updateTag("site:{id}") → the overview re-renders → the message
```

- **Nothing from the form is an authority.** Organization, site, role, permission and address come from the URL, the session and the database. The form's `status` is what is asked for, checked against the schema and the current status. Fields like `organizationId`, `siteId` or `role` sent along are never read (tested).
- **The form names the status it wants; it is not a toggle.** A double click, a resent request or a page loaded before someone else published asks for the same status again and changes nothing, so it can never flip the site back.
- **Concurrency:** the row lock makes two requests for one site take turns. The second sees the first's status, so eight simultaneous "publish" requests make one change and one record (tested), and mixed requests leave the site exactly where the last record says.
- **Switching back to Coming soon does not need a verified address.** It hides the site; nothing is shown to anyone that was not before.
- **Success is said only after the commit.** The message comes from the service's return value. A failed record or a refused commit is an error in the dialog, and the site is not called live.

### 3. Audit

`site.status_changed`, with `{ name, previousStatus, newStatus }`, each status `coming_soon` or `live` and nothing else (a suspended site is refused before anything is recorded). The M4-5 instructions suggest `site.published` "if that is the approved event name"; the approved name is `site.status_changed` (M4-3's hand-off), one event for both directions, as `site.theme_changed` is for themes. The activity log says "Ada published the site Bakery." or "Ada switched the site Bakery back to Coming soon."

Written in the status change's transaction by the existing writer (ADR 0010): actor, organization and site checked in SQL. A failed insert, or a refused commit, leaves the old status (tested). A refused request writes nothing.

### 4. Cache

`setSiteStatus` returns `{ type: "site.statusChanged", siteId }`, which flushes `site:{id}` only (immediate `updateTag`). The renderer's `loadPublicSite(orgId, siteId)` carries that tag (ADR 0013 §1), so the next request to the address sees the new status. No other site's tags, and no `host:` tag, are touched: the address does not change.

The E2E test warms the cache by opening the Coming soon page first, then publishes through the dialog, then opens the same URL: the live page (production build, real cache).

### 5. What the public sees

| | Coming soon | Live |
|---|---|---|
| `/s/{address}` | the theme's Coming soon page | the theme's page template: the site's name and tagline (ADR 0013; real pages arrive with M5-6) |
| other paths | the Coming soon page | the theme's not-found page, 404 |
| robots | `noindex, nofollow` | `index, follow` at `/` |
| URL | `/s/{address}` | the same |
| analytics scripts | none | none (§6) |

No canonical tags, sitemaps or other SEO were added; those are M8's.

### 6. Analytics scripts are not emitted, on any site

ADR 0014 §3 emitted the GA4 and Plausible snippets on live sites. Until now no site was live, so they never ran in production. **That emission is now off, for every site, live or not**, until an explicit consent and privacy decision has been made and built.

- The smallest change: `ANALYTICS_SCRIPTS_ACTIVE = false` in `modules/rendering/ui/analytics.tsx`, and the site layout asks `emitsAnalytics(status)` (false whatever the status) before drawing `SiteAnalytics`. The component, its double validation (`safeAnalytics`), and the order of the checks are kept for when it is turned on.
- **The settings stay:** the GA4 and Plausible fields, their schemas, saving, the `site.settings_changed` record and the overview's card are unchanged. The settings form and the overview now say tracking is not active yet.
- **Tests:** a unit test pins the flag off for every status; E2E saves both IDs on a live site and finds no script, no ID in the page and no request to either service, then the same on a Coming soon site.
- **Turning it on** needs the consent behaviour first (what visitors are asked, where it is remembered on a shared origin, and which countries need it), then this flag, M12-1's `script-src` for the two origins, and the E2E test reversed.

### 7. The overview

`/{org}/sites/{site}`, below the status and its explanation:

- **Coming soon**, for those with `site.settings.manage` and a verified address: **Publish site…**, a dialog that says the site goes from Coming soon to live at its full public URL, what visitors and search engines will get, that the home page shows the site's name and tagline for now and pages and posts cannot be added yet, and that it can be switched back. *Cancel* or *Publish site*.
- **Coming soon, address not verified:** "Verify your email address to publish this site." with a link to `/verify-email`, and no button.
- **Live:** **Switch to Coming soon…** (its own confirmation) and a link to the public site.
- **Suspended**, or anyone without the permission: nothing. The server refuses them anyway (tested with the button already open).
- **The public URL** is `APP_ORIGIN` + `/s/{address}` (`publicSiteUrl`, `overview.service.ts`), from the site's `domains` row; never the admin slug. The address card shows it in full too.
- **After success** the dialog closes, the message ("Bakery is live.", with "View your site") takes focus, and the page re-renders with the new badge, explanation and checklist.
- **The checklist's "Publish your site"** links to the button (`#publish`) while Coming soon, for those who have it.

### 8. Findings

- **Audit times are transaction start times.** `audit_logs.created_at` is `now()`, the start of the transaction. When two status changes overlap, the second may have started first, so the activity log (ordered by `created_at`) can list them in the opposite order to the one the lock imposed. The records themselves are a consistent chain (tested by their UUIDv7 ids, which `record()` makes after the lock). Fixing the display would mean `clock_timestamp()` in the audit writer, an ADR 0010 change; not done here.
- **Everything that changes a site's status should go through `setSiteStatus`'s lock** (M12-1's suspend and unsuspend can call the repository's `lockSiteStatus` and `updateSiteStatus` and emit the same event), so that staff and tenants cannot interleave.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| The form names the target status | Repeats and stale pages are harmless | One hidden field per form | — |
| Row lock (`for update`) | Simple, one site at a time, no retry loop | Concurrent requests for one site wait | — |
| One event for both directions | The vocabulary describes a change, as for themes | The sentence is chosen from `newStatus` | — |
| Analytics off everywhere | No tracking before visitors can be asked | Customers' saved IDs do nothing yet | A consent decision is made and built |
| Unpublish built now | The issue's criterion is `↔` | One more dialog | — |

## Not in M4-5

Pages, posts and a Home page draft (M5); canonical tags, sitemaps (M8); suspension controls (M12-1); site deletion changes; a consent banner or manager; any analytics provider beyond the two.

## Evidence

- `src/modules/sites/publishing.test.ts`: the transition table; the request's schema; the service's order (permission, verified address, lock, write, record, event) with the database replaced; refusals that touch nothing; the cache tag.
- `src/modules/sites/ui/site-publishing.test.tsx` (DOM): the dialog's title, description, public URL and consequences; cancel; what is sent; success and refusal states; focus.
- `src/modules/sites/ui/ui.test.tsx`: the control by status, permission and verification; the checklist link; the full URL; the analytics copy.
- `src/modules/rendering/analytics.test.ts`: no status emits analytics.
- `src/modules/audit/events.test.ts`: the event's schema and sentences.
- `tests/integration/publishing.test.ts` (real Postgres): both directions with their records and the renderer's answer; the form ignoring other fields; repeats; a stale page; concurrency; a failed record, a refused commit and a failed update; roles; the verified address; suspended; another organization's site; a deleted site; another site untouched; plan limits unchanged.
- `tests/integration/isolation.test.ts`: the form, both statuses, B's site from either URL or by id.
- `tests/integration/audit.test.ts`: the event is covered by a mutation.
- `tests/e2e/publishing.spec.ts`: create → Coming soon (overview, public page, `noindex`) → publish by keyboard and click → live (overview, database, log, public page at the same URL, `index, follow`, no tracking, nothing internal); back to Coming soon on a phone; an unverified Owner; an Editor, and an Admin demoted with the dialog open; a site suspended with the dialog open; another organization's site.
- `tests/e2e/site-settings.spec.ts`: saved analytics IDs emit nothing on a live or a Coming soon site, and nothing is requested.
