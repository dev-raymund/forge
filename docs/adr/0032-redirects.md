# ADR 0032: Redirects and the not-found page

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-30 |
| **Issue** | M8-5 (v1-github-issues.md) |
| **Decisions touched** | Plan §9 (Publish "auto-redirect if the path changed"; Unpublish "offer redirect this URL to…"), §10 (Redirects), §19 (`/…/seo/redirects`), §20 (`site:{id}:config`); cms-architecture §12.7 (route resolution order), §17.3 (D-20, simplified to exact match); builds on ADR 0016 (paths and `moveSubtree`), ADR 0017 (the public routes), ADR 0019 (terms), ADR 0024 (the lifecycle), ADR 0030 (menus), ADR 0031 (SEO), ADR 0009 (`site.seo.manage`), ADR 0010 (the audit vocabulary), ADR 0002 (Cache Components) |

## Context

**M8-5's criteria:**
- `redirects` table; `/…/seo/redirects` CRUD (exact match; 301/302/307/308; active toggle).
- Validation: leading `/`, not reserved, no self-redirect, loop detection (depth 10), chains flattened on write.
- Auto 301 on a published path change (slug, parent, blog path, term slug) in the publish transaction; publishing at a redirected path deactivates that redirect with a notice.
- A cached redirect map checked first in route resolution.
- A custom 404 page setting.
- **Testing:** unit loop and flatten cases; E2E: rename a slug, and the old URL 301s.

**What already existed:**
- **The table** (M1-1): `redirects (organization_id, site_id, source_path, destination, status_code, origin, is_active, created_by)`. It has `UNIQUE (site_id, source_path)`, a CHECK on 301/302/307/308, a CHECK that the source is a path outside `/_forge`, and RLS. No migration is needed.
- **The setting** (M1-1): `site_settings.not_found_entry_id`, a composite foreign key to the site's entries, `ON DELETE SET NULL`.
- **The permission:** `site.seo.manage` ("incl. redirects"), held by Owners, Admins and Editors.
- **The hand-offs:** where paths change (M5-3, M5-6, M5-7, M5-8), unpublish's prompt (M7-1), typed menu links (M8-3), the SEO page (M8-4).

## Decision

### 1. The rules (`seo/redirects.ts`, pure and client-safe)

| | Rule |
|---|---|
| **Source** | A path of the site as visitors type it, matched **exactly**. It is percent-decoded segment by segment, as Next decodes a request (`/caf%C3%A9` and `/café` are one address), case kept, trailing slash dropped. Refused: a query or fragment, an empty, `.` or `..` segment, an encoded `/`, control characters or quotes, more than 16 segments or 1,024 characters (no public route is longer), `/`, and Forge's own `/_forge…`, `/sitemap.xml`, `/robots.txt` |
| **Destination** | A path of this site (the same rules; `/` allowed; no query or fragment), or an absolute `http(s)` address on another host: no credentials, no spaces or quotes, at most 2,048 characters, stored as the browser would send it. Never `javascript:`, `data:`, `//host`, or this deployment's own host, which would reach another site or the admin (use a path) |
| **Status** | 301, 302, 307 or 308 (DB CHECK). A path change makes a 301; a new redirect is 301 unless another is chosen |
| **Self, loops, length** | A redirect to itself is refused. Its destination is followed through the site's active redirects: coming back to the source, or more than 10 steps, is refused (`followRedirects`) |
| **Flattening** | Writing A→B while B→C exists stores A→C; writing B→C while X→B exists points X at C (`planRedirectWrite`). Every chain is one hop, so a visitor is sent once |

### 2. What a source and a destination may be (`seo/redirects.service.ts`)

**Content always wins its own address.** The site answers some addresses itself:
- `/`;
- a published entry's exact path, in the site's language;
- the blog's index;
- an existing category's or tag's archive;
- any later page of a list (`…/page/n`), whether or not it has posts yet.

None of those may be a redirect's source (`servedPaths`, the public routes' rules; `blogRouteOf` is checked against `routeFor` in `rendering/routes.test.ts`).

**A destination path must be one the site serves now**, or the source of another active redirect, which is followed to its end, where the site must serve the page. A list's later page is refused ("send them to the list itself"). Nothing else on the site counts: not a draft's address, not another site's page at the same path.

**One redirect per source per site**: changing a redirect is editing it, not adding another. A site holds at most 10,000 redirects. Past that, new ones by hand are refused; those a path change makes are still made.

### 3. Written by Forge, in the transaction that changes an address

| Change | Redirects from → to | Turned off (content took the address) |
|---|---|---|
| **Publish** (by hand or on schedule: `makeLive`) | its own old path, if it was live and changed; each live page below it that moved | its new path, and theirs |
| **A page moved** (`movePage`) | it and each live page below it | their new paths |
| **The Home page changed** (`setHomepage`) | each live page that moved (the new Home's old address → `/`), except an address something else now serves: the old Home's `/` stays the site's | their new paths |
| **A new blog path** (reading settings) | the old index, and every category's and tag's archive | the new index and archives |
| **A category or tag renamed** (`updateTerm`) | its old archive | its new archive |
| **A category or tag created** | none | its archive |

**Shared by all of them** (`redirectPathChanges`, after the content's own rows are written):
1. Take the site's redirect lock.
2. Turn off the redirects from the addresses now served.
3. For each old address nothing now serves, upsert an automatic 301 to the new one, and point every redirect that ended at the old address straight at the new one.

Drafts and scheduled entries have no public address, so their moves leave none.

**Posts and a new blog path:** posts stay at the path they were published at (ADR 0017), and are found there. Publishing one again moves it under the new path, with its own redirect. The old lists' later pages are not redirected (exact match only).

**"Publishing at a redirected path deactivates that redirect with a notice":** the change's result carries what it turned off, and its success message says so:
- the editor: "Published. The redirect from /summer-sale is turned off: the site shows its own content there now.";
- likewise on a move, the home page, a term's form and the reading settings;
- the scheduled job turns it off silently.

**Atomic:** the redirects are written in the content change's own transaction. A failed redirect write fails the change (nothing moved), and a refused change (a taken address anywhere in a moved tree) writes no redirect. Integration tests force both.

### 4. Unpublished, in the trash, restored, deleted for good

- **Unpublished:** its address answers "not found", with the content private, unless the person sends its visitors elsewhere: unpublish's "redirect this address to…" (plan §9).
  - It appears in the unpublish dialog, for those who manage redirects.
  - It makes a redirect by hand (301), checked by §1–2, in the unpublish's transaction. A destination the rules refuse refuses the unpublish, said in the dialog.
  - Nothing picks a destination by itself: no redirect to the home page or a parent.
- **In the trash** (unpublish first, ADR 0024): the same; its address is free for others, and a redirect by hand may take it.
- **Restored** (as a draft): not public, so a redirect left at its address keeps answering. **Published again:** the page takes its address back, and that redirect is turned off with the notice. A taken address still refuses the restore, as in M7-1.
- **Deleted for good:** nothing changes. Redirects whose destination it was answer "not found" (§5).
- **A deleted category or tag:** its archive answers "not found"; no redirect is made (a redirect by hand can send it elsewhere).

### 5. The public site (`rendering/redirects.ts`, the site page)

**Order** (cms-architecture §12.7):
1. **The redirect map.** One `'use cache'` read per site, tagged `site:{id}` and `site:{id}:config`: active redirects only, matched in memory. No database round trip per request once cached.
2. The routes (entry by path, blog, archives).
3. Not found.

Only a live site's paths are looked up: a coming-soon site redirects nothing.

**A redirect is followed only to a destination the site serves now.** Its route must resolve (cached under `site:{id}:routes`), or the source answers 404 like any unknown address. So a redirect never sends a visitor to an unpublished page. An address elsewhere is sent as stored.

**The response** is answered before anything streams, so the status is real:
- **Location:** the site's public address (`/s/{address}` + the encoded path in V1, from the locator, never a request header), or the external address.
- **No query carried:** the source is matched on its path alone, and whatever follows `?` is not carried over. A fragment never reaches the server; browsers keep it (RFC 9110 §10.2.2).
- **The status sent:** a page of the App Router can answer 307 or 308 (or 303), not 301 or 302 (Next 16's `redirect()`/`permanentRedirect()`). Site pages answer GET and HEAD only, where 301 and 308 mean the same, as do 302 and 307, and search engines treat 308 as 301. So a permanent redirect (301, 308) is sent as **308** and a temporary one (302, 307) as **307**. The stored code is kept as chosen (the API and host mode may send it exactly) and the page says so.
- **Next 16 quirk:** the first, uncached render writes its response headers twice (`link` too, on every page), so a fresh redirect carries the same `Location` twice. Browsers accept identical copies. The cached answer after it has one.

**Canonical, sitemap and robots** are unchanged and agree with this:
- canonicals are built from the current stored path;
- the sitemap lists current stored paths only, so a redirect's source is never in it;
- robots.txt does not list redirects.

**Typed menu links:** a menu `url` link written as a path is not rewritten when a page moves. Its old path now redirects (ADR 0030). Links to entries and terms by id follow by themselves, as before.

### 6. The site's not-found page (plan §10 "custom 404 page setting")

- **What it is:** a published page of the site (not the Home page, not a post), named on the redirects page (`site_settings.not_found_entry_id`).
- **Where it shows:** at every address a live site does not have, with a real 404 and `noindex`, inside the theme's frame (`not-found.tsx`, `notFoundPageFor`). It is read from its published revision like any page, cached under its entry's tag and the site's config.
- **Unpublished or in the trash:** the theme's not-found page is shown again; the setting stays and is flagged on the page.
- **Deleted for good:** the foreign key clears the setting.
- **Its own address** still shows it, with 200. Marking it noindex in its SEO tab keeps it out of search results.
- **Saved** as an SEO setting (`site.settings_changed`, group `seo`, field `notFoundPage`).
- **An id that is not the site's entry** is "not found".

### 7. The redirects page (`/…/seo/redirects`, `seo/ui`)

- **Access:** from the SEO page ("Redirects and the not-found page"), for Owners, Admins and Editors. Others get the no-access notice, and the server refuses them.
- **Add:** the old address, where it goes, and the status code, with an explanation of what is sent. Refusals are shown at their field. A success names what was stored, including a chain it shortened and the redirects it pointed straight at the new address.
- **The list:**
  - newest first, 50 a page, with a search over both addresses;
  - each row shows the code, "Automatic: the address changed" or "By hand", "Elsewhere" and "Off";
  - a warning when a redirect's destination is not published now ("visitors … get 'not found' until it is").
- **Each redirect:** Turn off / Turn on (turning on checks its address again), Change (destination, code), Delete… (confirmed).
- **The not-found page:** what is shown now, a search for published pages, and "Use the theme's not-found page".
- **Layout:** no sideways scroll at 390 px; axe clean.

### 8. Concurrency, isolation, audit, cache

- **One redirect lock per site:** every redirect write takes a transaction-scoped advisory lock (`pg_advisory_xact_lock`), always after the locks the change already holds (the entry, the site's settings row, a term). Writes that read the map, to flatten or to look for loops, take turns, and nothing holds this lock while waiting for another, so it cannot deadlock.
  - **A race, tested five times:** a post renamed to an address while someone redirects that address elsewhere. Whichever goes first, no redirect is left on over the published post.
  - **Terms:** a term's creation and a slug change now take the site's settings lock first, so the blog path their archives depend on holds still.
- **Isolation:** every query names the organization and the site, under RLS.
  - Another site's redirect id is "not found"; a destination is checked against this site only; each site's map is its own read.
  - The isolation suite runs every form with B's slug, with A's slug and B's site, with B's site id as the slug, and with B's redirect or page from A's own site: all NotFound, B unchanged (the `redirects` table is now in its digest).
- **Audit:**
  - `redirect.created`, `redirect.updated` (the fields: destination, status, active) and `redirect.deleted`, with the site's name, the addresses and the code;
  - "redirect this address to…" is recorded as `redirect.created`;
  - redirects a path change makes are not recorded one by one: the change's own record (`entry.published`, `entry.moved`, `term.updated` with `previousSlug`, `site.settings_changed`) is the record.
- **Cache:** every write returns `site.configChanged`, which flushes the map at once. That covers redirects by hand, and any path change that made or turned off one (even a first publish at a redirected address, which changes no path).

## Not in M8-5

- **Exact 301/302 on the wire:** see §5. Reconsider with a proxy-level lookup (Vercel routing middleware with a key-value map) if an exact code matters to someone.
- **Prefix or regex redirects, `preserve_query`, hit counts, CSV import** (plan §10: not V1; cms-architecture §17.3).
- **Host-level redirects and custom domains** (M9): `siteBasePath` is where the primary host goes; a non-primary host's 308 is M9-2's.
- **Redirect limits by plan** (M11): one fixed cap of 10,000 for now.
- **A redirects API** (M10): `GET/POST/DELETE /v1/sites/{siteId}/redirects`.
- **A 404 monitor** suggesting redirects (LATER).
- **A request in flight during a change:** a visitor's request that read the map just before a change committed can be stored by Next's page cache after the change's flush, and keep the old answer until the site's config is flushed again or the cache's lifetime ends. This is true of every public change since M5-6, not only redirects. CI showed it once, when a test asked for an address while its redirect was still being saved; the tests now wait for the change's answer, as an editor does. M12-2 measures the cache.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| The map in the renderer, cached under `config` | No round trip per request; the architecture's resolution order; one tag every writer already flushes | 308/307 on the wire instead of 301/302 | An exact code is required (proxy-level map) |
| Content wins its address (sources must be free; publishing turns a redirect off) | A redirect can never hide a published page, so "redirects first" shadows nothing | A redirect is lost (turned off) when content takes its address; it stays listed, off | — |
| A destination followed only while the site serves it | Never a redirect to an unpublished page; nothing private is revealed | A redirect to a page that is away answers 404 meanwhile | — |
| Automatic redirects in the content change's transaction | All or nothing: no moved page without its redirect, no redirect without the move | Every path change takes the redirect lock | Very large subtree moves |
| Chains flattened on write, under a per-site lock | One hop for every visitor; loops impossible to race in | Writes to one site's redirects take turns | — |
| One row per source, upserted by path changes | A path that moves again takes over its old row | An old row's choices (code, by hand) are replaced when content moves away from that address again | — |
| No query carried | Exact match on the path; nothing tenant-unknown appended | Tracking parameters are dropped | Owners ask (`preserve_query`) |
| No automatic redirect on unpublish, trash or term deletion | Nothing picks a destination for the person | Old links answer 404 until someone adds one | — |

## Evidence

- **Unit:**
  - **`seo/redirects.test.ts` (58):**
    - **sources:** decoding, case, trailing slash, `%2F`, `..`, broken escapes, control characters, `/`, Forge's own, length and depth; the reserved list equals content's;
    - **destinations:** paths, http(s) normalised; `javascript:`, `data:`, `//host`, `ftp:`, `mailto:`, credentials, this host, spaces and quotes, length;
    - **chains:** followed to the end and elsewhere; self, loops (direct, through the map, a cycle among others), more than ten steps; flattening both ways;
    - **the status sent;** the `Location` encoding.
  - **`rendering/routes.test.ts`:** 16 cases checking `blogRouteOf` against `routeFor`.
  - **`audit/events.test.ts`:** the three events' sentences, and the not-found page's.
- **Integration (`tests/integration/redirects.test.ts`, 16, real Postgres):**
  - **By hand:**
    - added by the three roles and refused for Authors and Viewers;
    - normalised; recorded; the map's reads flushed;
    - 308/307, to `/`, elsewhere, a decoded path.
  - **Refused at the field:** every served kind of source, Forge's own, a duplicate; destinations not served (a draft, another site's page), a list page, unsafe, this host, itself; a loop through the map; a chain past ten (written behind the services' back); an unknown key or code.
  - **Flattened** both ways, with notes. A redirect to an unpublished page answers 404 until its destination redirects on.
  - **Changed, off and on, deleted:** each recorded and flushed; turning on is refused while a page is published at the source.
  - **A failed record saves nothing.** The rename-and-redirect race runs five times.
  - **By Forge:**
    - **A post's slug:** 301 → 308; canonical and sitemap current; renamed again, one hop; back to the first, which takes its address back (turned off). An idempotent publish writes nothing.
    - **A page moved with its subtree:** a draft below makes none; a typed menu link is not rewritten and redirects; moved back, the addresses are theirs again.
    - **The Home page:** the new Home's old address → `/`; none from `/`.
    - **A new blog path:** the index and both archives redirect; the post stays; later list pages are not redirected; the republished post gets its own; and back.
    - **A renamed category:** a tag of the same slug is another address; a new category takes the old archive back; a deleted one leaves none.
    - **Publishing at a redirected address:** the form's notice, the flush.
  - **Rollbacks:** a redirect insert forced to fail fails the publish (nothing moved); a move refused by a taken address writes no redirect.
  - **Unpublish, trash, restore:** "redirect this address to…" (refused destinations refuse the unpublish; the form's message; Authors refused it); not found otherwise; trash, a redirect by hand at the address, restore as a draft, publish takes it back.
  - **The not-found page:** refused (a post, a draft, the Home page, another site's page, a Viewer); set, recorded, flushed; drawn; unpublished → the theme's; cleared.
  - **Isolation:** another site's map, rows and forms.
  - **Existing tests updated:** `content-entries.test.ts` (a path change now also flushes the site's config; the home page's message names its redirect), `audit.test.ts` (the three events covered), `isolation.test.ts` (9 operations; `redirects` in the digest).
  - **Mutation checks**, each caught by a test:
    - without the redirect lock;
    - without turning off claimed addresses;
    - without the "served now" check on old addresses;
    - without flattening on a path change;
    - without the destination check on the public site;
    - without loop detection (unit);
    - without the published-only filter;
    - without the config flush on publish;
    - without the list-page refusal;
    - without the term rename's redirect.
- **E2E (`tests/e2e/redirects.spec.ts`, 4, production build):**
  - **A post's new slug, published from the editor:** the editor's notice; `308` with `Location: /s/{address}/blog/rye-bread` (GET and HEAD, no query carried); a visitor lands there; canonical and sitemap current; renamed again, one hop.
  - **A page moved from its editor:** it and the page below it 308.
  - **The redirects page** lists all four as Automatic.
  - **By hand:** refused at the field (a published address, `javascript:`); 301 → 308, 302 elsewhere → 307; flattened with its note; off → 404, on → 308; changed → 307; deleted → 404.
  - **The not-found page** chosen by search: an unknown address answers 404 with it, noindex; back to the theme's ("Page not found").
  - **Layout:** axe clean; 390 px without sideways scroll.
  - **Unpublish:** a refused destination is said in the dialog; with `/offers` → 308; without → 404.
  - **A new blog path:** `/blog` → 308 `/news`; a post stays 200.
  - **Roles:** Authors and Viewers get the notice.
  - **Coming soon:** redirects nothing; another site's redirect is not this site's.
  - **`content-terms.spec.ts`:** a renamed category's old archive now 308s to the new one (it was a 404 until M8-5).
- **Manual (dev server):** 308 with the site's path and no query; 307 elsewhere; 404 for a destination not published. See the final report for the browser checks on the demo sites.
