# ADR 0013: The public renderer: address → site → status → theme, with real 404s

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-10 |
| **Issue** | M4-3 (v1-github-issues.md) |
| **Decisions touched** | D-27 (cache tags), D-37 (two root layouts); builds on ADR 0002 (Cache Components, real 404s), ADR 0006 (`/s/{address}`, one origin), ADR 0011 (sites, addresses), ADR 0012 (themes) |

## Context

Since M0-4, `/s/{address}` was answered by the spike's view: the site's name, its tagline, and debug details (the path, the base path, when the data was cached), for every status, and indexable. M4-4 made the themes and the contract to draw them (`themeFor`). M4-3 replaces the spike with the renderer.

## Decision

### 1. One flow, decided before anything streams

```text
GET /s/{address}/{path}          proxy.ts: strips cookies and Authorization; refuses Server Actions and /render/* (ADR 0006)
 → /render/address~{address}/{path}
 → layout: publicSiteFor(locator)
      resolveSite(locator)               'use cache', tag host:{address}          domains (platform): → site, organization, primary
      loadPublicSite(orgId, siteId)      'use cache', tags site:{id}, site:{id}:config   sites + site_settings, withTenant({ orgId }): RLS applies
   a site it may show → <html lang={site's language}> + the theme's frame (header, footer, fonts, settings as variables)
   otherwise          → a bare page
 → page: renderStateFor(site, path)      pure (modules/rendering/render-state.ts)
 → not-found.tsx when the page calls notFound()
```

`modules/rendering` holds the lookups, the decision and the platform's two pages. The site tree (`app/(sites)`) composes them, and never imports `modules/auth` (lint).

### 2. What each request gets

| The site | The path | Answer | Status | Robots |
|---|---|---|---|---|
| none at the address (or malformed) | any | the platform's "Site not found" | 404 | noindex |
| `suspended` (or a status the renderer does not know) | any | the platform's "This site is unavailable": no name, no words, no theme | 404 | noindex |
| `coming_soon` | any | the theme's coming-soon page | 200 | noindex, nofollow |
| `live` | `/` | the theme's page template, with the site's name and tagline | 200 | index, follow |
| `live` | anything else | the theme's not-found page, in the site's frame | 404 | noindex |

- **Coming soon covers every path**, so nothing unpublished can be reached by guessing. M7-4's preview tokens will bypass it.
- **A live site has no pages yet.** Routing to content (`resolveRoute`: home page, pages by path, posts, archives) is M5-6. Until then the home page is the theme's page template with the site's name, the "live placeholder" of plan Phase 4, and every other path is not found.
- **Unknown statuses fail closed:** anything but `coming_soon` and `live` is "unavailable".
- **Titles:** the site's name where its theme draws the page; "Site not found" / "Site unavailable" on the platform's pages. No canonical or Open Graph URL is emitted: site SEO is M8's.

### 3. Real statuses, and where they come from

- **404s are real.** The page calls `notFound()` outside `<Suspense>`, before anything streams (ADR 0002, discovery 1), so the response status is 404 and Next adds `noindex`.
- **The theme draws its own not-found page.** Next gives a `not-found.tsx` no params, so the layout records the site it resolved for the request (`rememberRequestSite`, a per-request `cache`). The not-found page reads it (`requestSite`) and draws the platform's page or the theme's template. The layout always runs before its not-found boundary renders.
- **A suspended site answers 404, not 503.** The long-term design (cms-architecture §(b)) says "site unavailable (503)". A Next.js page can produce 404 (`notFound()`), and, behind an experimental flag, 401 and 403, but not 503. The proxy, which could, does not know a site's status, and adding a database lookup to every request through it would change ADR 0002's design. 404 keeps the page out of search engines and is never mistaken for success. It is also distinct from "Site not found" in what it says. To answer 503 later: a route handler for unavailable sites, or a status hint the proxy can read without the database.
- **Server rendering of a 404:** React error boundaries do not run during server rendering. When a page calls `notFound()` before anything streams, Next answers with the 404 status, a minimal document (`noindex`) and the not-found tree in its payload, which the browser then renders. Visitors see the page; a client without JavaScript sees an empty 404. This is Next's behaviour for every shell-level `notFound()`, the admin's included.

### 4. Caching

- **Two cached functions, two keys.** `resolveSite(locator)` is keyed by the address, `loadPublicSite(orgId, siteId)` by the site. One site's entry can never be another's, and no tenant setting is cached globally.
- **Each change flushes what it changed:**
  - `host:{address}`: creating a site (a cached "no such site" for the new address goes), moving it (old and new), deleting it (ADR 0011);
  - `site:{id}`: a theme switch (ADR 0012), and the status change of M4-5;
  - `site:{id}:config`: settings, from M8-1.
- **A moved or deleted site's old address** finds nothing as soon as the change commits: the `domains` row is gone and its `host:` tag is flushed.
- **Per request,** `publicSiteFor` is wrapped in React's `cache`: the layout, the page, its metadata and the not-found page share one lookup.
- **The page's HTML is rendered per request** from the cached data. There is no full-page cache that could hold another visitor's response, and none is needed for V1 volumes.
- **The lint rule:** a `'use cache'` function must take its tenant as an argument (`siteId`, `orgId`, `locator`, `host`, …), and a file-level `'use cache'` is refused. A cached value without a tenant in its key would be shared between sites (`eslint.config.mjs`, tested in `tests/unit/lint-boundaries.test.ts`).

### 5. What a public page may know

The theme receives `RenderableSite` (ADR 0012): the site's name, tagline, language, base path, theme key and stored theme settings. It gets no id, no status, no organization, no member and no session. The lookups themselves take an address and ids, and read no cookie, header or session. A signed-in member of any organization sees exactly what a stranger sees (tested by comparing the rendered `<main>` of both, for every role).

### 6. Removed

The M0-4 spike, as its hand-off asked:
- `spikes/rendering/` (`queries.ts`, `actions.ts`, `admin.ts`);
- `/dev/cache`;
- `POST /api/dev/revalidate`;
- `tests/e2e/rendering-spike.spec.ts`.

Its guarantees are kept by `tests/e2e/renderer.spec.ts` on the real renderer, except one: the background invalidation path (`revalidateTag(…, { expire: 0 })` from a route handler). It has no real caller until scheduled publishing (M7-2) and stays unit-tested in `platform/cache`.

## Not in M4-3

- **Host mode's redirect** of a non-primary host to the primary (the issue's post-V1 item). `resolveSite` already returns `isPrimary`; the redirect comes with custom domains (M9).
- **Preview** (M7-4), publishing (M4-5), content routing (M5-6).
- **Site SEO** (canonical, Open Graph, robots.txt, sitemaps: M8).
- **503 for unavailable sites** (§3).

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Status read in a `site:{id}`-tagged function, not with the address | A status change (publish, suspend) must not need the address to flush | Two cached reads per site instead of one | — |
| Coming soon at every path | Nothing unpublished is reachable by guessing a path | Deep links to a coming-soon site show the holding page, not a 404 | — |
| Suspended answers 404 | Next pages cannot answer 503; 404 stays out of search and out of "success" | Monitors see "not found" rather than "unavailable" | A route handler or proxy hint is worth it (§3) |
| The layout records the site for its not-found page | Next gives not-found pages no params, and the theme must draw them | Relies on the layout rendering before its boundary, as React does | Next passes params to not-found pages |
| A live home page is the page template with the site's name | Plan Phase 4's "live placeholder", without inventing content | A live site has one page until M5 | M5-6 |

## Evidence

- `src/modules/rendering/render-state.test.ts`: every status × path, the statuses, robots.
- `src/modules/rendering/public-site.test.ts`: the public context holds no id; links from the base path; the page's language.
- `tests/unit/lint-boundaries.test.ts`: the `'use cache'` rule.
- `tests/integration/renderer.test.ts` (real Postgres):
  - known and unknown addresses;
  - an address change; a deleted site;
  - each status through the real lookups;
  - the chosen theme; damaged settings and a retired theme key;
  - another organization's ids finding nothing;
  - no id in the public context.
- `tests/integration/sites.test.ts`: the resolver after create, move and delete.
- `tests/e2e/renderer.spec.ts`:
  - coming soon at every path, `noindex`, `lang`, no debug output;
  - Studio and Journal;
  - live home and a themed 404;
  - suspended and unknown addresses;
  - routing guards; headers;
  - caching until invalidated;
  - a theme switch showing on the very next request, with another site's cache untouched;
  - two sites' branding.
- `tests/e2e/tenancy.spec.ts`: a member of any role sees what a stranger sees, `<main>` for `<main>`.
