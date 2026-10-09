# ADR 0014: Site settings, the overview, and onboarding's steps 2 and 3

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-10 |
| **Issue** | M4-2 (v1-github-issues.md) |
| **Decisions touched** | D-30 (audit), D-27 (cache tags); builds on ADR 0006 §5 (analytics on the shared origin), ADR 0009 (`site.settings.manage`), ADR 0010 (audit writer), ADR 0011 (sites), ADR 0012 (themes), ADR 0013 (renderer) |

## Context

`site_settings` has had its JSONB groups (`general`, `reading`, `seo`, `analytics`, `theme`) and a `version` column since M1-1; `createSite` writes them empty (ADR 0011). M4-2 gives a site its settings screens (general, reading, analytics), its overview, and onboarding the two steps after the organization. No table, column or constraint changed: there is no migration.

## Decision

### 1. The settings

| Group | Fields | Stored in | What uses it now |
|---|---|---|---|
| general | name, language, time zone | `sites.name`, `default_locale`, `timezone` | the site's header and title, `<html lang>` |
| | tagline, social links | `site_settings.general` `{ tagline, social: { facebook, instagram, x, linkedin, youtube, tiktok } }` | the theme's pages; the footer's "Social" links |
| reading | blog path (one segment, default `blog`), posts per page (1–50, default 10) | `site_settings.reading` | nothing yet: posts arrive with M5. The page says so |
| analytics | GA4 measurement ID, Plausible domain (both optional) | `site_settings.analytics` | a live site's pages (§3) |

- **Strict in, lenient out:**
  - What is submitted is checked by the group's schema (`modules/sites/settings.ts`). An unknown key, a bad value, or a field of another group is refused, and nothing is saved.
  - What is stored is read value by value, as the theme kit does (ADR 0012). A damaged value falls back to its default alone, and a page never breaks on it.
- **Social links** are full `https` addresses only. No `javascript:`, no other scheme, no spaces or quotes.
- **Optimistic concurrency:** each form carries the `version` its page was rendered with. The save writes only `where version = it` and adds one.
  - Someone else's newer save wins, and this one gets "Conflict: reload the page".
  - A request without a whole-number version cannot win.
  - The page re-renders after a save, so the forms carry the new version.
- **Saving changes only what changed.**
  - The same values again write, record and flush nothing, and the version stays.
  - A change writes the group (rewritten whole from the schema's output, so no key of an older shape lingers) and, for general, the site's columns. It records `site.settings_changed` with the group and the *names* of the fields that changed, never their values, in the same transaction. If the record fails, or the commit is refused, nothing changes.
- **Who:** `site.settings.manage` (Owner, Admin), asked before the input is looked at. The site comes from the URL and the session, and a form's other fields (organization, site, theme, status) are never read.

### 2. Cache

A settings save emits `site.configChanged`, which flushes `site:{id}:config` only. The renderer's `loadPublicSite` carries that tag (ADR 0013), so the public site shows the change on the very next request. No other site, and no address, is touched. A theme switch stays `site:{id}` (ADR 0012).

### 3. Analytics on the shared origin

ADR 0006 §5 allows exactly this: on the shared V1 origin, only GA4's and Plausible's official snippets may be emitted, built by our code from validated IDs, with no free-form code.

- **Live sites only.** A coming-soon page is mostly seen by the site's own team, who are admins on the same origin, so it carries no third-party script.
- **The snippets:**
  - GA4: `gtag/js?id={id}` plus the standard `gtag('config', '{id}')`;
  - Plausible: `script.js` with `data-domain`.
  - Both are emitted through `next/script`, after the page is interactive.
- **The IDs are checked twice:** by the settings schema when saved (`G-` plus capitals and digits; a hostname), and again by the renderer right before they are written into the page (`safeAnalytics`), whatever they were read from.
- **The theme never sees them.** The layout emits them; the theme context has no analytics.
- The full `script-src` policy is still M12-1, and must allow these two origins on site pages.

### 4. The overview

`/{org}/sites/{site}` (every member) shows:
- the status and what it means (a suspension's reason is never shown);
- the public address, linking to `/s/{address}`;
- the theme;
- the language and time zone, the reading settings, and which analytics are on;
- the launch checklist;
- for those who may read the activity log, the site's five latest events.

"Change" links appear only for those who may. Publishing is M4-5's.

**The launch checklist** (plan §3) has five items: pages, menu, SEO, the site's address, publish. Each is done or not from what the database holds:
- published pages (`entries`);
- menus with items (`menus`);
- any SEO value set;
- an address;
- `live`.

Only the address links somewhere, to the settings page, because that is the only screen that exists. The others say "Not available yet." The counts read the content and navigation modules' tables through the schema barrel, in the organization's context.

### 5. Onboarding's steps 2 and 3

```text
/onboarding                          step 1: the organization (M3-3) → step 2
/onboarding/{orgSlug}                step 2: CreateSiteForm, createSiteAction (flow "onboarding") → step 3
/onboarding/{orgSlug}/{siteSlug}     step 3: ThemePicker, chooseThemeAction → "Continue to your site"
```

- **The same forms and actions** as `/{org}/sites/new` and the Appearance page.
  - Step 2 binds `flow: "onboarding"`, which changes only where the action goes next. Any other value is the admin's flow.
  - The site service, the permission, the plan's limit and the audit record are the ones of M4-1.
- **The organization and the site come from the URL** and are checked against the membership (`requireOrgPage`, `requireSitePage`), as on every admin page. Nothing about onboarding is in the session.
- **Progress is what exists; nothing is stored** (`onboardingNext`):
  - no organization: step 1;
  - an organization without a site, whose member may create one: step 2;
  - otherwise, done.
  - `/onboarding` resumes accordingly, and a refresh stays on the step in the URL.
  - Step 3 needs no resuming: the site already has Studio, and the same picker is on its Appearance page.
- **Who has nothing to do here:** a member who may not create sites, or whose organization already has one, is sent from step 2 to the organization's sites. One who may not choose the theme is sent from step 3 to the site.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| One version for all three groups | The column exists, and one number is simple to carry | Two people editing different groups at once: the second reloads | Conflicts are seen in practice |
| The audit names fields, not values | Settings can be long; the page shows the values | "Which tagline was it before?" is not answered | Someone needs history of values |
| Analytics only on live sites | Less third-party script on the admin's origin | No analytics while coming soon | Users ask |
| Onboarding progress derived from data | No table, nothing to keep in step with reality | Step 3 cannot be "resumed"; it is optional | Steps that create nothing are added |
| Reading settings saved before posts exist | The plan's settings page, with honest copy | A setting with no effect yet | M5-6 uses them |

## Not in M4-2

Publishing (M4-5); the pages, menus and SEO the checklist points to (M5, M8); logo and favicon (M6-4); the footer's social toggle in the appearance editor (M8-1; the default shows them); homepage selection (M5-3).

## Evidence

- `src/modules/sites/settings.test.ts`: every schema, refusal, default and lenient read.
- `src/modules/sites/overview.test.ts`: the checklist and where onboarding resumes.
- `src/modules/rendering/analytics.test.ts`: what analytics a page may carry, and the cache tag.
- `src/modules/sites/ui/ui.test.tsx`: the overview's markup by permission; the settings forms carry their version.
- `tests/integration/site-settings.test.ts` (real Postgres):
  - each group saved and read back, normalised; the public data following;
  - the record names fields only;
  - unchanged saves write nothing;
  - invalid input, a stale or missing version, an unknown group, a failed record or a refused commit change nothing;
  - roles; another organization's site;
  - theme and settings independent;
  - the overview's checklist from real rows;
  - onboarding's resume, and the create-site flow's next step.
- `tests/integration/isolation.test.ts`: the settings form, every group, with another organization's site from either URL.
- `tests/e2e/site-settings.spec.ts`:
  - the overview;
  - general, reading and analytics saved and reloaded;
  - the public site's new name, tagline, language and social link;
  - the snippets on a live site;
  - an Editor; another organization; a phone.
- `tests/e2e/onboarding.spec.ts`: organization → site → theme, resumed after a refresh and after leaving; step 2's refusals; a phone.
