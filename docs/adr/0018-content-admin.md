# ADR 0018: Content admin: the lists, the new forms, the entry's settings, the page tree

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-13 |
| **Issue** | M5-7 (v1-github-issues.md) |
| **Decisions touched** | Plan §5 (entries), §13 (RBAC), §19 (admin routes); builds on ADR 0003 (editor), ADR 0009 (authorization), ADR 0010 (audit), ADR 0016 (entry services), ADR 0017 (public content) |

## Context

M5-3 built the entry services, M5-4 the editor, M5-5 the blocks, M5-6 the public pages. An entry could be reached only from the site overview's Home page card. M5-7 adds what surrounds the editor: the pages tree, the posts list, the new forms and the entry's settings. It also answers the open question of sites made before M5-3, which have no Home page.

## Decision

### 1. Screens and operations

| Screen | What it does | Service (all in one transaction each, audited where they change something) |
|---|---|---|
| `/…/pages` | The tree; search by title, status filter; drag a page among its siblings, Move up/down, Move under… | `listPages`, `placePage` (`entry.reordered`), `movePage` (`entry.moved`) |
| `/…/posts` | Filters: status, category, author, title; sorts: recently edited, recently published, title, oldest; 25 a page | `listPosts`, `listTerms` |
| `/…/pages/new`, `/…/posts/new` | Title, and the parent and template (pages) or the author (posts); then the editor | `createEntry` (M5-3), `setHomepage` (M5-3) for "Make it the home page" |
| The editor's settings | The slug, template, excerpt, categories and tags (saved with the draft); the parent, the author, "Set as home page" (at once) | `saveDraft`, `movePage`, `changeAuthor` (`entry.author_changed`), `setHomepage` |

Every list and mutation names the context's organization and site, which come from the URL's slugs resolved against the session. No organization, site, role or permission is read from a form. The lists' filters are GET forms parsed by `parsePageQuery` and `parsePostQuery`: a malformed value is dropped, so a URL can show less, never more.

### 2. Who sees what: an Author's own posts, and no pages

Plan §13 gives `entries.*.read` to every role. The M5-7 criterion, and plan §21's acceptance line ("Author: no settings, no pages, can write posts"), narrow what an Author sees in the admin. `ownPostsOnly(ctx)` decides this from permissions, never from a role: it holds when the member has `entries.post.update.own` but neither `.any` nor any page right. Then:

- **The posts list** holds only their own posts, whatever the URL asks. The filter is applied in `listPosts`.
- **The pages** are not in their nav. The pages screen says "no access", and `listPages` refuses.
- **A page's editor, or another member's post, is "not found"**, like another site's entry.
- **The link picker** finds only published entries and their own posts.

The Viewer, who only reads, still reads everything. The permission catalog (ADR 0009) is unchanged.

### 3. The page tree

- **Moving a page** (`movePage`) is immediate, as `setHomepage` is. The page's path becomes its slug under the new parent's path, and every page below follows (`moveSubtree`), in one transaction. The move is refused when:
  - it would make a loop;
  - the page is moved under itself;
  - the parent is a post, in the trash, of another site or language, or does not exist;
  - a post is being moved;
  - the new address is reserved (`reservedPathReason`);
  - an address in the moved tree is already taken. This is a Conflict that names the address.

  Nothing moves when it is refused. The Home page keeps `/` under any parent.
  - **Live pages:** whose address changed return `entry.moved` events, which flush their render, the routes and the config (ADR 0017).
  - **Redirects** from the old addresses are M8-5's.
- **Ordering siblings** (`placePage`) writes `sort_order`. The tree and the lists show that order, and M8-3's menus may follow it. No address changes, so nothing public is flushed.
- **Both take the site's settings row lock first**, as `setHomepage` does. Every change to one site's tree waits its turn, so two moves at the same moment cannot make a loop that neither saw (tested).

### 4. The author

`changeAuthor` is for those who may edit the entry and edit anyone's entries of its type (Owner–Editor). The new author must be a member of the organization. The author belongs to the entry, not the draft, so the change is immediate and recorded with both names. An Author cannot change the author of their own post, because only the "any" right credits others.

### 5. The entry's settings, beside the text

- **Draft fields** (slug, template, excerpt, categories and tags) travel in the editor's autosave payload, and only once they have been changed in the sidebar.
  - **Why only changed fields:** a slug that was valid when saved can become reserved later, for example when the blog's path changes. Resending it on every save would block saving the text.
  - **Slug checks:** a slug joins the payload only once it passes the server's own rules (`typedSlug`, `reservedPathReason`). An invalid slug shows its reason and leaves the last valid one in place.
  - **Taken slugs:** a slug another entry holds is refused at publish, naming the address (M5-3). There is no earlier read-only hint yet.
- **Immediate actions** (move, author, "Set as home page") answer without re-rendering the page (`refresh: false`), and the editor updates its own header and settings. A refresh under an open editor could hand it a draft version older than its own autosave's, and the next save would be a false conflict. The page tree refreshes itself after a move.
- **The featured image** is a slot that says it arrives with the media library (M6-4).
- **Categories and tags:** the sidebar offers the site's existing terms. Creating them, inline or on their own screens, is M5-8's (§7).

### 6. New entries, and sites without a Home page

- The new forms post to `createEntryAction` (M5-3), which now redirects to the new entry's editor. Nothing is created on GET.
- **A generated slug** takes the next free one (`insertWithUniqueSlug`). **A typed slug** is used as typed or refused, never suffixed (M5-3).
- **"Make it the home page"** (Owner, Admin) calls `setHomepage` right after `createEntry`. The permission is checked first, so nobody creates a page only to be refused. They are two transactions: if the second were refused, the page would exist and its editor would open.
- **Sites made before M5-3 have no Home page.** The overview and the pages screen say so and offer "Create the home page" to those who may, and `/` keeps showing the site's name and tagline (ADR 0017). Nothing is created by a request, and no backfill ran.
- **Backfill decision:** existing production sites without a Home page need a controlled, idempotent backfill before public launch. It is recorded as a launch dependency in M12-2, with its scope and verification.

### 7. Overlap with M5-8

The M5-7 criteria put "categories/tags" in the editor sidebar. M5-8 lists "assignment in the editor sidebar writes `entry_drafts.term_ids`" and "Authors can assign existing terms and create tags".

- **Built here:** assigning existing terms, because `saveDraft` already writes them.
- **Left to M5-8:** creating terms (inline or on their screens), managing them, and their cache events.

### 8. Lists

- **The page tree loads every page,** up to 1,000 (V1 sites are far below that), in tree order. Filtered, it is a flat list of matches with their addresses, and nothing can be dragged.
- **Posts go by page numbers** (25 a page, with the total), not by the activity log's cursor. The list is sortable four ways, and "page 3 of 7" is what editors need. The activity log is an append-only stream, which a cursor suits.
- **The category filter and the categories shown** are the draft's, which is what the editor shows. Published assignments are what the public archives use (ADR 0017).

## Not in M5-7

- Term screens, term creation and their cache events (M5-8).
- The media picker and the featured image (M6-4).
- Unpublish, trash, the trash filter and purge (M7-1).
- Redirects for moved pages (M8-5).
- Menus (M8-3).
- An early "this slug is taken" hint while typing (a read-only check; not needed for correctness).

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Author visibility from permissions (`ownPostsOnly`) | The criterion; no role checks (ADR 0009); no catalog change | The rule reads three permissions, not one | A dedicated read scope is wanted (`entries.post.read.own`) |
| Page moves immediate, not at publish | The tree is structure, like the Home page (ADR 0016); a draft parent change would leave the stored path untrue until publish | Moving a live page changes its address at once | Editors ask for scheduled restructures |
| One lock per site for tree changes | Correctness of the loop check under concurrency, simply | Two moves in one site queue (milliseconds) | Large sites restructure concurrently |
| Sidebar draft fields only when changed | A stale slug can never block autosave | The first change of a field is what sends it | — |
| Sidebar actions without a refresh | The editor keeps its draft version | The rest of the page updates on the next navigation | — |
| Posts paged by number | Sortable four ways; totals | Offset cost grows with depth | Sites hold tens of thousands of posts |
| Pages capped at 1,000 in the tree | One query, a whole tree | A huge site sees a note and searches | Such sites exist: lazy-load branches |

## Evidence

- `tests/integration/content-admin.test.ts` (real Postgres): the tree and its filters, never another site's pages; the posts list's filters, sorts and pages; an Author's own posts only, whatever the URL; the editor and the link picker following the same rule; the forms (redirect, generated slug, a new Home page); refusals that write nothing (an Editor's home page, an Author's page, a parent or an author from elsewhere); `movePage`, with paths below and cache tags for live pages, refusals (loop, self, post, trash, other site, reserved, taken) leaving every path as it was, two concurrent moves that would loop, the Home page under a parent; `placePage`; `changeAuthor`, with its refusals; the role matrix; the handlers' `refresh: false`.
- `src/modules/content/list-query.test.ts`, `src/modules/sites/overview.test.ts`, `src/modules/audit/events.test.ts`.
- `tests/e2e/content-admin.spec.ts` (production build):
  - pages from the nav, a new page under another with a template, the tree, Move up, dragging, Move under… with its preview, a loop not offered, search and filter;
  - posts: a new post, the slug, excerpt and a category saved with the draft, publishing at the new slug, then filters, search, sort and two pages;
  - "Set as home page", moving the old Home page, changing an author;
  - an Author's view;
  - a site without a Home page, made from the overview, at 360 px.
