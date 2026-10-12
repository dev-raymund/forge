# ADR 0017: Public content: routes, the closed renderer, templates and freshness

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-13 |
| **Issue** | M5-6 (v1-github-issues.md) |
| **Decisions touched** | D-27 (cache tags), D-38 (closed renderer); builds on plan §6.2, §7, §10, §20, ADR 0002 (caching), ADR 0003 (editor, block registry), ADR 0012 (themes), ADR 0013 (public renderer), ADR 0016 (entry services) |

## Context

Since M4-3 a live site showed one page: its name and tagline, through its theme's page template, at `/`; every other path was the theme's 404. M5-3 made publishing (entries, revisions, terms), M5-4 and M5-5 the editor and the block registry. M5-6 connects them: visitors see what was published, at its address.

## Decision

### 1. One flow, still decided before anything streams

```text
GET /s/{address}/{path…}
 → layout: publicSiteFor(locator)                 unchanged (ADR 0013); the site now carries its reading settings
 → page:   renderStateFor(site)                   status only: site-not-found · site-unavailable · coming-soon · live
           live → publicPageFor(site, path)       per request (React cache), on four cached reads:
                    resolveRoute(org, site, locale, blogPath, segments)   tags site:{id}, site:{id}:routes
                    loadEntry(org, site, entryId)                           tags site:{id}, site:{id}:entry:{eid}
                    loadPostList(org, site, locale, page, perPage, term)    tags site:{id}, site:{id}:list:post
                    livePaths(org, site, locale, entryIds)                  tags site:{id}, site:{id}:routes
           null → notFound()                       the theme's not-found template, a real 404
 → PublicPageView: the theme's template, with the document rendered by the closed renderer as its content
```

`modules/rendering` holds the reads (`content.ts`), the path rules (`routes.ts`), the renderer (`document.tsx`) and the view (`ui/public-page.tsx`). It reads the content tables through the platform schema, as it already reads `sites` and `domains`: the public rule (published, not in the trash, this site, this language) exists only here, and the admin never uses it.

### 2. Addresses

| Path below `/s/{address}` | What it names |
|---|---|
| `/` | the entry stored at `/` (the Home page) if it is published; otherwise the site's name and tagline (M4-3's live home) |
| `/{blogPath}`, `/{blogPath}/page/{n}` | the blog index, page n ≥ 2 |
| `/{blogPath}/category/{slug}`, `/{blogPath}/tag/{slug}`, `…/page/{n}` | a term's archive |
| any other path | the published entry stored at exactly that path: a page (nested or not) or a post |

- **One spelling per address.** Every segment must be a slug as entries store them, so `/About`, `/about%20us` or `/blog/page/01` name nothing. Page 1 of a list is the list's own address (`…/page/1` is a 404, not a redirect). A path past the last page is a 404; an empty blog is an empty first page.
- **A post is found at the path it was published at.** Changing the blog's path (reading settings) moves the index and the archives at once; existing posts stay at their old paths until they are published again (M5-3 left this to M5-6 or M8-5: decided here; redirects for it are M8-5's).
- **The language** is the site's (`sites.default_locale`). Entries of another locale are not shown (V1 has one per site).
- **Sites without a Home page** (made before M5-3) and sites whose Home page is still a draft show the site's name and tagline at `/`. Nothing is created or backfilled during a request. Creating one in the admin is M5-7's.

### 3. Draft privacy and isolation

Content comes only from the revision `entries.published_revision_id` names, joined on the entry and the site, of an entry whose `status` is `published` and `deleted_at` is null. Drafts, saved changes after a publish, scheduled and trashed entries are never read. Every query names the organization, the site and the locale; RLS holds as well. The theme receives titles, dates as text, excerpts, term names and public addresses: no id, status, draft, organization or analytics ID (tested in the rendered HTML).

### 4. The closed renderer

`renderDocument(document, context)` walks `{ v, doc }` and emits only `RENDERED_ELEMENTS`; no stored HTML and no `dangerouslySetInnerHTML` exist anywhere on the path.

- **Every node is checked again**, against the block registry's schemas, whatever was checked on save: a legacy document, or one written around the services, renders what is valid and skips the rest. The text nodes and marks are drawn here; the custom blocks by `BLOCK_RENDERERS` (M5-5); `columns` is handed its rendered columns.
- **A skipped node is reported, never silent:** unknown (or out of place), invalid, too deep (24 levels), too many (5,000 nodes), or not rendered yet. The report is logged once when the entry is read into the cache, not on every request.
- **Links.** `entry:{id}` resolves to the live path of an entry of this site and language (`livePaths`); anything else (a draft, the trash, another site's or organization's entry) is plain text, and a button to it is not drawn (M5-5's rule). A site path gets the site's base (`/contact` → `/s/acme/contact`, `/` → `/s/acme`). Other addresses pass `isSafeHref` or are not links. A button that opens a new tab gets `rel="noopener noreferrer"`.
- **Embeds.** YouTube and Vimeo through their privacy players (`embedSrc`); a generic page only if it passes `platform/net/url-safety` and is not Forge's own host (`APP_ORIGIN`). Frames are lazy, sandboxed (`allow-scripts allow-same-origin allow-presentation allow-popups`; the videos add the media `allow` list; a generic page adds `allow-forms`, which a form or a booking widget needs), with a strict referrer policy.
- **The image** (schema since M5-5) is skipped and reported until M6-4 gives it a renderer: a page that holds one renders everything else.

### 5. Templates and styles

- **The contract** (`themes/types.ts`): eight templates, `page`, `page-full-width`, `page-landing`, `post`, `blog-index`, `term-archive`, `coming-soon`, `not-found`. Content arrives rendered (`children`); a theme draws the frame, never the document.
- **A page's template** is the stored `template` of its published revision: `default`, `full-width`, `landing` (`PAGE_TEMPLATES`); null or an unknown key is the default. Choosing it is M5-7's sidebar.
- **Studio** has all eight. **Journal** has its page templates (the two wide ones share one layout) and uses the kit's post, blog index and archive (`_kit/templates/blog.tsx`) until M8-2 designs its own. This is the one boundary between M5-6 (the types make every theme draw every template) and M8-2 (Journal's blog design).
- **Block styles** are the kit's (`_kit/blocks.css`, loaded by `ThemeFrame`), in the kit's variables: buttons and their alignment, columns (the widths as the `--forge-columns` property from the validated ratio, one column on phones when `stackOnMobile`), embeds by aspect, spacers, dividers, quotes with their attribution in a `figure`, the post list, pagination, term links. A column's content wraps (`min-width: 0`), so long words and addresses never widen the page.
- **Dates** are written in the site's language and time zone; an unknown one falls back to English and UTC.

### 6. Freshness (D-27, unchanged events)

| Change | Event (existing) | What is flushed |
|---|---|---|
| Publish, first time | `entry.published` | its entry, the routes (and so the links to it) at once; its type's list stale-while-revalidate |
| Publish again | `entry.published` | its entry at once; no purge needed |
| Path or parent change | `entry.published` (`pathChanged`) + `entry.moved` per live page below | each moved entry, the routes, the config at once |
| New Home page | `site.configChanged` + `entry.moved` (old and new Home) | the routes and both entries at once |
| Coming soon ↔ live, suspension | `site.statusChanged` | the site umbrella: every read above |
| Theme switch | `site.statusChanged` | the site umbrella |
| Reading settings | `site.configChanged` | the site's config, which hands `blogPath` and `postsPerPage` to every content read as part of its key |

Every read is also tagged `site:{id}`, so the umbrella reaches all of them, and every tag names one site: a change to one site never flushes another, and the cache keys hold the organization, the site and the locale, never only a path. The blog index and archives use the list tag, which publishing marks stale (`revalidateTag(…, "max")`, D-27): the first request after a publish may still show the old list, and the next is fresh.

### 7. What did not change

The proxy, the Server-Action and `/render` guards, `noindex` for coming-soon sites and 404s, `index, follow` for a live site's pages, the neutral page for unavailable sites, `site.status_changed`, the M4-5 publishing flow and `setHomepage`. Analytics scripts stay off (`ANALYTICS_SCRIPTS_ACTIVE`): their IDs are stored and validated, and never reach a page. No canonical URL, Open Graph, description, sitemap or redirect is emitted: site SEO is M8's.

## Not in M5-6

Image rendering (M6-4); the page template picker and creating pages from the admin (M5-7); term management and its cache events (M5-8); preview (M7-4); unpublish and trash (M7-1, whose events already flush these reads); Journal's blog templates (M8-2); SEO, sitemaps and redirects (M8-4, M8-5); the author's name on posts (it lives in the identity tables, which the site tree may not read).

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| The public read rule lives in `modules/rendering`, reading content tables through the platform schema | One place says what is public; the admin's rules differ (drafts, trash); the site tree stays free of the editor's code | Two modules read `entries` | A third public reader appears (the API, M10): move the rule behind the content module's API |
| Exact stored paths only, no normalization or redirects | One address per page; no duplicate content; no redirect policy invented before M8-5 | `/About` is a 404 | M8-5 adds redirects |
| Posts stay at their published path when the blog's path changes | Nothing moves without a publish; old links keep working | Old and new posts can sit under two blog paths until republished | M8-5 (redirects) or a bulk "move posts" action |
| Re-check every node at render | Stored documents may predate a rule or bypass the services | A Zod parse per node per render | Render cost shows in profiles: cache rendered HTML per entry |
| Skips logged at cache fill, not per request | No log flood; still never silent | A damaged page is logged once per cache lifetime | — |
| Lists stale-while-revalidate after a publish | D-27 as designed: lists are cheap to serve stale, expensive to rebuild under load | One request may show the old list | Editors report it as confusing: make `list:` immediate for publishes |
| Journal uses the kit's blog templates | Every theme must draw every template (types); Journal's design is M8-2's | Journal's blog looks plain until M8-2 | M8-2 |
| A generic embed may submit forms | A form or booking widget is the approved generic use | One more sandbox permission for third-party pages | A generic embed is abused: drop it, or allow-list hosts |

## Evidence

- `src/modules/rendering/document.test.tsx`: every block the editor makes, marks, quotes, lists; internal links (live, another site's, deleted); the image skipped and reported; invalid and out-of-place nodes; nested columns; depth and size limits; the XSS corpus (the spike's 31 payloads and 21 more: generic embeds of private hosts, IPs, credentials, ports, http, Forge, data:; frame attributes; class injections; prototype keys; non-string text).
- `src/modules/rendering/routes.test.ts`: every route shape, one spelling per address, page numbers, limits; dates in the site's language and zone.
- `src/modules/rendering/ui/public-page.test.tsx`: templates by stored choice, links under the base, post terms and dates, pagination, titles, no ids or analytics in the HTML, Forge never framed.
- `src/themes/themes.test.tsx`: every template of both themes (landmarks, one `h1`, escaped words), the wide templates, post lists, pagination, empty lists.
- `tests/integration/public-content.test.ts` (real Postgres): the Home page before and after publishing, drafts after a publish private; nested pages, posts, other spellings; the trash, another site, another organization, another locale; `entry:` links; the blog index and archives, pagination, terms; a blog path change; each read's tags, and that publishing, a path change with pages below, a new Home page, status, theme and reading settings flush them; one site's change never touching another's tags.
- `tests/e2e/public-content.spec.ts` (production build): a site's pages, posts, blog, archives and blocks (columns, buttons, embeds: lazy, sandboxed, privacy players, nothing third-party loaded); drafts, the trash, other sites', unknown terms, pages past the end and other spellings as themed 404s; analytics off; a hostile document inert; a phone; and, in the admin, publish → visible, a saved draft private, republish → updated, Coming soon ↔ live and a theme switch, each on the next request.
- `tests/e2e/renderer.spec.ts`, `publishing.spec.ts`, `tenancy.spec.ts`, `appearance.spec.ts` (every template of both themes in the gallery) still pass.
