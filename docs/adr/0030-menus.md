# ADR 0030: Menus

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-20 |
| **Issue** | M8-3 (v1-github-issues.md) |
| **Decisions touched** | Plan §4.1 (`menus`: one per location, items a JSONB tree), §7 (themes draw menus), §19 (`/…/menus`), §20 (`site:{id}:config`); builds on ADR 0012 (the theme kit, `NavItem`, `Nav`), ADR 0013 and ADR 0017 (the public renderer, its cached reads and tags), ADR 0024 (the entry lifecycle), ADR 0009 (`site.menus.manage`), ADR 0010 (the audit vocabulary), ADR 0029 (no client code on site pages) |

## Context

**M8-3's criteria:**
- `menus` table (one per `header`/`footer`), `items` JSONB validated (depth ≤ 2, ≤ 100 items; kinds `entry`, `term`, `archive`, `url`; no `javascript:`).
- `/…/menus` tree editor: add from page/post/category search or URL, drag to reorder and nest, label override, new-tab toggle.
- Themes render menus; items pointing at unpublished or trashed entries are omitted; invalidates `config`.
- **Testing:** unit: schema validation; E2E: trash a linked page → the menu item disappears from the live site.

**What already existed:**
- **The table** (M1-1): `menus (site_id, location, items, version, updated_by)`, unique per site and location, with RLS.
- **The permission:** `site.menus.manage`, held by Owners, Admins and Editors.
- **The checklist:** the overview's "Set up your menu", counting menus with items.
- **The themes:** both draw `context.menus.header` and `context.menus.footer` through the kit's `Nav`, flat and empty until now.

**The M7-1 hand-off:** an entry can be unpublished, trashed and purged. `menus.items` is JSON with no foreign key, so an item can outlive its entry.

## Decision

### 1. The data (`navigation/shared.ts`, client-safe)

A menu is an array of items; an item is one link, and a top-level item may have links under it (two levels).

| Kind | Stored | Drawn as |
|---|---|---|
| `entry` | `entryId` | its live path; label defaults to its **published** title |
| `term` | `termId` | `/{blogPath}/{category\|tag}/{slug}`; label defaults to its name |
| `archive` | `contentType: "post"` | `/{blogPath}`; label defaults to "Blog" |
| `url` | `url` (a site path, or `https`/`http`/`mailto`/`tel`: the header button's `safeHref`) | the path under the site's base, or the address |

Every item also has:
- an `id` (a UUID made by the editor);
- a `label` (trimmed, ≤ 80 characters; required for `url`);
- `newTab`.

**Two readers of the same data:**
- **`checkMenuItems`** (saving) is strict:
  - an unknown kind or field, an unsafe address, a third level, more than 100 links (both levels counted) or a repeated id refuses the whole menu;
  - errors are keyed by item (`item.{id}`), or `items` for the menu as a whole.
- **`readMenuItems`** (the public site, the editor) is lenient: it reads stored JSON value by value and drops what does not read as a link (a third level, links past 100). A damaged menu draws fewer links, never an error.

**Ids, not addresses:** a renamed or moved page keeps its menu link, with no redirect needed for it (M8-5 handles old URLs elsewhere).

### 2. Saving (`navigation/menus.service.ts`, `saveMenu`)

1. **Permission:** `requirePermission(site.menus.manage)`; an unknown location is NotFound.
2. **The items:** `checkMenuItems`.
3. **One transaction:**
   - **Unchanged:** the same items as stored change nothing; nothing is written, recorded or flushed.
   - **Version:** the menu must still be at the version the editor opened (0 when it has never been saved). Otherwise Conflict, and nothing is written. The first save inserts (`on conflict do nothing`: a race is a Conflict too).
   - **Destinations new to the menu** are looked up in this site:
     - a page or post that exists and is not in the trash (any status: a draft may be linked ahead of publishing);
     - a category or tag of the site.

     Another site's entry or term, one that does not exist, or one in the trash is refused at that item. Nothing an id says is trusted.
   - **Destinations already in the menu are kept as they are,** even if their page is now unpublished, trashed or purged. A later save never loses an item because its page is away for a while; the editor flags it (§4) and the person decides.
   - **Recorded** as `menu.updated` (resource `menu`): the site's name, the location, and how many links it holds. Never the links themselves.
4. **After the commit:** `site.configChanged` flushes `site:{id}:config`.

### 3. What the public site draws (`rendering/menus.ts`, `loadMenus`)

**Where it is read:** the site layout loads both menus (`publicMenusFor`), as do the two preview pages (ADR 0027, ADR 0028), so a preview shows the real header and footer.

**One cached read per site, `'use cache'`, tagged:**
- `site:{id}:config`: the menus, and the blog's path (`site.configChanged`);
- `site:{id}:routes`: what is live and where. Publishing, unpublishing, the trash, a move and a term's change all flush it immediately (D-27).

**Each item is resolved as the site is now:**
- **`entry`:** drawn only while the entry is published, not in the trash, this site's, and in the site's language. Its label is the published title (`entries.title`): a draft's new title is never read.
- **`term`:** drawn while the category or tag exists.
- **`archive` and `url`:** drawn as stored (checked when saved).

**The stale-reference behaviour (chosen):**
- **Left out, never rewritten.** An item whose destination is not live is left out of the site: a draft, a scheduled post, a page in the trash, a purged page, a deleted term, or an id from another site (which can only be there if the data was written behind the app).
- **Its links take its place** if a top-level item is left out. Nothing valid is lost.
- **It comes back by itself** when its page is published again (or restored, then published). No menu edit is needed, since the menu never changed.
- **A purged entry or deleted term stays in the menu, flagged** in the editor ("it was deleted. Remove this link"), until someone removes it.

**What the cached read returns:** paths relative to the site. `menuNavItems` puts the site's base in front (`/s/{address}` in V1), so a menu can never link into another site.

### 4. The editor (`/…/menus`, `navigation/ui/menu-editor.tsx`)

**The page:**
- **Access:** "Menus" in the site's links and on the overview's checklist, for Owners, Admins and Editors. Others get the no-access notice, and the server refuses them anyway.
- **Layout:** two sections, Header menu and Footer menu, each its own form with its own version and Save.

**Adding a link:**
- **Page or post:** search by title (the link picker's `/api/app/entries/search`). Drafts and scheduled posts are labelled as such.
- **Category:** from the site's categories.
- **Blog.**
- **Address:** link text, then a path or address, and "Open in a new tab". It is checked in place with the same `checkMenuItems`, so `javascript:` is refused before it is ever sent.

**Arranging:**
- **Drag:** a link by its handle, before or after another, or onto the middle of a top-level link to put it under it.
- **Keyboard:** each link's Arrange menu has Move up, Move down, "Move under the link above" and "Move out to the top level".

  Both use the same pure functions (`navigation/tree.ts`), which never make a third level.

**Editing:** Edit opens a link's label (its default shown as the placeholder), "Open in a new tab", and Remove (with its links, for a top-level link).

**Flags:** a link whose destination is not live says why, under the link:
- not published;
- scheduled;
- in the trash: "Restore and publish it, or remove this link";
- deleted: "Remove this link".

**States:**
- "No links yet" when empty;
- "Unsaved changes" with Discard;
- success shown only once the server has answered;
- errors under the link they concern, or above the Save button.

**Accessibility:**
- a live region announces each add, move and removal;
- `n of 100 links` is shown;
- at 360 px there is no sideways scroll.

### 5. How the themes draw two levels (`_kit/components/nav.tsx`)

`NavItem` gains `newTab` and `children`. Site pages ship no client code (ADR 0029), so the links under a link need none:

- **Headers (`submenus="disclosure"`, both themes, every variant):**
  - **The button:** beside the link, a `<summary>` named "More links under {label}", announced as expanded or collapsed and opened by Enter, Space or touch. Its list follows the `<details>` and is shown while it is open.
  - **On a phone:** the open link takes a row of its own with its links under it.
  - **From 48rem:** a panel under the link. The last link's panel opens towards the page, as do all of Studio's right-aligned headers (classic, minimal), so it never runs past the edge.
- **Footers (`list`):** the links under a link are listed under it, always shown.
- **New tab:** `target="_blank"`, `rel="noopener noreferrer"` (added to any `rel` a list already has), and " (opens in a new tab)" for screen readers.
- **Styles:**
  - the kit's variables only (colours, corners, spacing), so M8-1's settings apply;
  - Journal centres its header menu, as its masthead is;
  - focus is the kit's;
  - no motion.

## Not in M8-3

- **More menu locations** (a mobile menu, theme-declared ones): V1 has header and footer.
- **`config_revisions` snapshots and restore:** deferred in V1 (plan §1.2). The audit record says that a menu changed and how many links it has.
- **A menus API (`GET /api/v1/sites/{id}/menus/{location}`):** M10.
- **Redirects:** M8-5. Menus need none for renamed entries (§1).
- **SEO, sitemaps:** M8-4.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Items name entries and terms by id, resolved at render time | Renames and moves never break a menu; nothing to rewrite | One more read per site, cached and tagged | — |
| Left out, not removed, when a destination is not live | Unpublishing or trashing a page for a while must not lose its place in the menu; it comes back by itself | A purged page leaves a flagged item until someone removes it | Owners ask for automatic cleanup on purge |
| Its links take the place of an item left out | Nothing that is valid disappears | The menu's shape changes while the parent is away | Owners prefer the whole group hidden |
| A destination new to a menu must be live-or-draft and this site's; kept ones are not checked again | A save never fails because of another item's state; ids from a browser are never trusted | A menu can hold links that show nothing (flagged) | — |
| The resolved menus are cached under `config` and `routes` | Every change that alters a menu already flushes one of them at once | Any publish re-reads the menus once | Menus grow large |
| `<details>` disclosure, no script | Site pages ship no client code (ADR 0029); keyboard, touch and screen readers work | No hover-to-open; a click outside does not close it | A theme needs richer menus |
| One version per menu | The header and footer are edited independently | Two forms on one page | — |

## Evidence

- **Unit:**
  - **`navigation/shared.test.ts` (9):**
    - every kind;
    - addresses: paths and https/http/mailto/tel accepted; `javascript:`, `data:`, `vbscript:`, `//host`, spaces and relative words refused;
    - labels;
    - two levels, 100 links, duplicate ids, unknown kinds and fields, an archive of pages;
    - the lenient reader.
  - **`navigation/tree.test.ts` (4):** moves, nesting in and out, drops (never a third level), removal, label and new-tab edits.
  - **`themes.test.tsx` (5):**
    - both themes' headers draw the disclosure (named, no script) and their footers the list;
    - a new tab carries the rel and the screen-reader text;
    - social links keep `rel="me"`.
  - **Others:** `audit/events.test.ts` (`menu.updated` sentences); `sites/overview.test.ts` (the checklist link).
  - **The public bundle:** `rendering/public-bundle.test.ts` still finds no client component reachable from site pages.
- **Integration (`tests/integration/menus.test.ts`, 10, real Postgres):**
  - **Saving:**
    - the four kinds and two levels saved at version 1, recorded, `site:{id}:config` flushed, drawn under the site's base;
    - the same menu again changes nothing;
    - versions 2, and the footer separately.
  - **Refusals:**
    - keyed by link: an unsafe address, a third level, 101 links, an unknown location;
    - destinations: another site's (same organization) or another organization's entry, a trashed one, a missing one, another site's or a missing term. A link already in the menu is kept after its page goes to the trash.
  - **Conflicts:** stale versions, service and form; unreadable JSON.
  - **Roles:** Owner, Admin and Editor yes; Author and Viewer refused (read, save, form).
  - **Nothing else touched:** the site's settings, the other menu, another site's menus. A failed record saves nothing.
  - **The editor:** flags live, unpublished, scheduled, trashed and deleted entries, and deleted terms; nothing is rewritten.
  - **The public site:**
    - only live destinations;
    - unpublish → its links take its place;
    - republish with a new title and slug → back as it is now;
    - a draft's new title is never drawn;
    - trash, restore (a draft) and purge → left out, still in the menu;
    - a renamed category, and the blog moved to `/news`, followed;
    - a deleted category left out;
    - another site's page, a scheduled post, an unsafe or third-level stored link → never drawn.
  - **Cache:**
    - each change's cache events flush a tag the menus were read under;
    - one site's save flushes none of another's.
  - **Mutation checks:** without the published-only filter, without the destination check, or without the `routes` tag, a test fails.
- **Isolation suite:** `navigation.submitSaveMenu` with B's slug and site, A's slug with B's site, and B's site id as the slug: NotFound, B unchanged (also for a member who may manage nothing). The `menus` table's full-table read returns A's rows only.
- **E2E (`tests/e2e/menus.spec.ts`, 4, production build):**
  - **Building menus:**
    - from the site's links and the checklist: search, a category, the blog, an unsafe address refused in place, a new-tab address;
    - nested by keyboard (the Arrange menu) and by dragging; a label of its own;
    - saved and reopened as saved;
    - the live Studio site draws both menus at once (the disclosure, the new tab's rel, the footer's label), with no axe violation and no sideways scroll, the last panel opening towards the page.
  - **The criterion's test:**
    - a linked page unpublished then trashed in the admin leaves the live menu on the next request;
    - the editor keeps it, flagged "in the trash";
    - restored, it stays out; published again, it is back.
  - **Themes:** Journal (centred) and Studio's classic, centred and minimal headers with simple and columns footers, at 360 and 1280 px:
    - by keyboard: Tab to the button, Enter opens, Tab reaches the first link under it;
    - every link inside the page; no sideways scroll; axe clean;
    - the footer lists its links under their link.
  - **Roles:** an Editor saves; an Author and a Viewer have no Menus link and get the notice; the editor fits a phone.
  - **Mutation check:** without the `routes` tag, the trash test fails.
- **Manual (dev server):** both demo sites' menus were built through the page. The Journal demo's footer holds a draft that the editor flags and the site leaves out. The Studio demo's header holds a draft page, likewise. Screenshots were taken at 1280 and 360 px; the Studio right-edge panel was found there and fixed.
