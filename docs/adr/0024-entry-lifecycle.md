# ADR 0024: The entry lifecycle: unpublish, the trash, restore, purge

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-16 |
| **Issue** | M7-1 (v1-github-issues.md) |
| **Decisions touched** | Plan §9 (Unpublish, Trash / Restore), §16 (`trash.purge`); cms-architecture §6.7 (retention), §13 (media usage), §16.1 (the state machine); builds on ADR 0016 (entries, publishing, paths, the homepage), ADR 0018 (the lists), ADR 0022 (`trash.purge`, the media trash), ADR 0023 (images in use) |

## Context

After M6-4, entries could be created, saved and published, and published again, but never taken off the site, thrown away or brought back. M7-1's criteria:

- **`lifecycle.ts`:** a pure state machine (draft, scheduled, published, plus the trash) with a permission for each transition.
- **The services:**
  - `unpublishEntry` (with an optional "redirect this URL to…");
  - `trashEntry` ("unpublishes in the same transaction, frees the path");
  - `restoreEntry` ("→ draft, slug re-suffixed");
  - `purgeEntry`.
- **The job and the lists:** `trash.purge` purges entries daily after 30 days; the lists get a trash filter.

The milestone's brief (the instruction this was built from) changed three of those points, and was followed:

| Issue / plan said | Built (the brief) | Why |
|---|---|---|
| Trash unpublishes in the same transaction | **Trash refuses a published (or scheduled) entry**: unpublish first | Two deliberate steps. Taking a page off the site is said and confirmed on its own |
| Restore re-suffixes a taken slug | **Restore refuses, naming the address**, and restores nothing | No silent new address. ADR 0016 already refused a typed slug rather than suffix it |
| Unpublish offers "redirect this URL to…" | **No redirect** | Redirects are M8-5's |

Two decisions the issue left open were made by the brief:
- **A page goes to the trash with its subtree**, and comes back with it.
- **Trashing the Home page is refused** until another page is made the Home page.

## Decision

### 1. The state machine (`content/lifecycle.ts`, pure)

`transition(state, action)` returns either the new state and the right the action takes, or the reason it is refused. The services ask it before they write; the policies ask it (`canTransition`) for the screens.

| From | Action | To | Right | Who |
|---|---|---|---|---|
| draft, published | publish | published | publish | pages: Owner–Editor; posts: an Author their own |
| published | unpublish | draft | publish | as publish |
| draft | schedule | scheduled | publish | defined for M7-2; not offered |
| scheduled | cancel_schedule | draft | publish | M7-2 |
| draft | trash | draft, in the trash | delete | pages `entries.page.delete` (Owner–Editor); posts `entries.post.delete.own`/`.any` |
| in the trash | restore | draft | delete | as trash |
| in the trash | purge | (gone) | delete_any | pages `entries.page.delete`; posts `entries.post.delete.any` (Owner–Editor) |

**Refused:**
- trashing a published entry ("Unpublish it first") or a scheduled one ("Cancel the schedule first");
- anything but restore and purge in the trash;
- restore and purge outside it.

**Visibility first:** an entry the caller cannot see is not found (an Author: other people's posts, and every page), as in M5-7.

### 2. Unpublish (`unpublishEntry`)

A published entry becomes a draft, in one transaction with its record (`entry.unpublished`):
- `published_revision_id` is cleared;
- its published term links (`entry_terms`) are deleted, so archives and term counts drop it.

**Kept:**
- every revision;
- the draft (its terms included);
- `published_at` and `first_published_at`. Publishing again brings back its first date (ADR 0016: the date is kept on republish).

**Not changed:**
- a draft is left as it is (a repeated click);
- pages below an unpublished page stay published at their addresses;
- unpublishing the Home page leaves `/` showing the site's name and tagline.

### 3. The trash (`trashEntry`)

**Taken in order, in one transaction:**
1. **The site's settings row is locked**, as every change to a site's tree locks it (moving and placing pages, setting the homepage, restore, purge), so they take turns.
2. **The entry is locked;** it must be a draft.
3. **The Home page is refused:** "Make another page the home page first". The existing `setHomepage` flow (Owner, Admin) is the way.
4. **For a page, every page below it is locked,** read again, and looked for again until no new one appears. Creating a page now share-locks its parent, so a page created under one of them during the trash is either waited for and found, or refused once its parent is in the trash.
5. **The whole subtree is refused,** naming the pages, if any of them is published or scheduled, or is the Home page.
6. **Every row gets the same `deleted_at`:** one `clock_timestamp()` in a CTE. That moment is how the pages trashed together are found again.

**What changes:**
- **Addresses:** each one is free at once (the unique index covers rows not in the trash), and a new entry takes it unsuffixed.
- **The cache:** nothing public changes (only drafts are ever trashed), so nothing is flushed.
- **The record:** `entry.trashed` (with `below`).

### 4. Restore (`restoreEntry`)

**Taken in order, in one transaction, under the settings lock:**
1. **The entry must be in the trash,** and for less than 30 days by the database's clock. Past that it is `trash.purge`'s: "being deleted for good".
2. **The group:** the entry and the pages trashed with it (the same `deleted_at`, to the microsecond, compared in SQL), locked.
3. **Where each one goes:**
   - **a page:** its slug under its parent's address as it is now. A parent that moved meanwhile carries the pages back with it, as live children would have moved.
   - **a post:** where it was.
   - **refused** if the page above is in the trash ("Restore that page first"), or if its parent was deleted for good (its old place no longer exists).
4. **Every address is checked before anything is written:**
   - a reserved one, or one an entry now holds, refuses the whole restore with a Conflict naming the address: "The address /about-us is now used by “About”…";
   - no suffix, nothing overwritten, nothing half-restored;
   - the unique index catches a path taken in the same instant.

**The result:**
- **Drafts:** they come back as drafts, never republished.
- **Records:** `entry.restored` (with `below`).
- **The cache:** nothing to flush.
- **Left in the trash:** a page trashed on its own before its parent stays there; it is restored afterwards, on its own.

### 5. Deleting for good (`purgeEntry`, by hand)

Under the settings lock:
- the entry in the trash and every page below it (all in the trash: a page in the trash never has live pages below it) are deleted;
- their drafts, revisions and published term links go with them through the existing `ON DELETE CASCADE` keys;
- media they used is not touched;
- `entry.deleted` is recorded, and earlier lines about the entry stay (the log is append-only).

### 6. `trash.purge`: entries, then media (`content/purge.ts`)

**One job, the same schedule, the same retention.**
- The `trash.purge` job is now defined in the content module. The content module already depends on media, and not the other way round.
- It runs `purgeTrashedEntries`, then M6-3's `purgeTrashedMedia` unchanged.
- One failing does not stop the other. The job fails afterwards so the failure is seen.
- `ENTRY_TRASH_DAYS = TRASH_DAYS = 30`; a unit test keeps them equal.

**Finding the work:**
- A SECURITY DEFINER lookup, `organizations_with_purgeable_entries(before, limit)`, migration 0013. It is owned by `forge_lookup`, which may read trashed entries for it only, and it returns organization ids only.
- Then each organization's own tenant context, site by site.
- Migration 0012 adds a partial index on `(site_id, deleted_at) WHERE deleted_at IS NOT NULL`.

**Each batch** (200, oldest first) **is one transaction:**
1. **The site's settings row is locked:** a restore that began first finishes first, and one that comes later finds nothing.
2. **Candidates:** the rows in the trash since before the cutoff, locked.
3. **Kept back:** anything with something below it that is not being deleted.
   - A trashed child that is due but falls in a later batch only defers its parent.
   - A live child, or a trashed one not yet due, would be orphaned (a broken invariant: `parent_id` is `ON DELETE SET NULL`), so that page is kept back and reported.
   - So is the site's Home page.
4. **The delete,** which checks again that each row is in the trash and past the cutoff.

**Safety:**
- **Bounded:** 500 organizations a run, a 30-second budget, and a site is done when a batch is not full or deletes nothing.
- **Retry:** a failed batch rolls back whole and is retried on the next run (tested with a forced failure at commit).
- **Recorded?** No, as M6-3's media purge: no one did it, and the trashing was recorded. The audit writer has no system actor yet (M7-2), and was not changed.

### 7. Lists and screens

**Lists:**
- `?status=trash` (`ENTRY_STATUS_FILTERS`) on `/…/pages` and `/…/posts`, with a "Trash" link on each.
- Rows are scoped to the site, and an Author sees only their own posts, as before.
- Pages: one row per trash of a page, with "with N pages below it" (those come back with it), and a mark on a page that waits for the page above it.
- Each row shows when the entry went to the trash and when it will be deleted for good.
- **Actions:** Restore (refusals shown in the row, never as done) and "Delete permanently…" (a confirmation that says how many pages go and that it cannot be undone), each offered only to those who may.

**The editor:**
- **Unpublish** beside Publish, behind a confirmation that says what leaves the site.
- **"Move to trash…"** under the entry's settings. It says how many pages go with it, or why it cannot (published, the Home page, a published page below, with names).
- What is typed is saved first; then the editor goes to the trash list.
- A trashed entry's editor is not found, as before; it is restored from the list.

### 8. Trashing an image in use: the warning

The issue left open whether purging media should warn about pages that still use it. **Decided:**
- **When:** the interactive media trash warns, not the purge, which has no one to tell.
- **No refusal:** it is restorable for 30 days, and pages show it again then.

**`mediaUsage(ctx, mediaId)`** (media module) reads the content tables for this site only, as the sites module reads them for its checklist:
- the pages and posts not in the trash that show the file:
  - as their featured image;
  - in an image block of their published revision, found by walking the stored JSON (`jsonb_path_exists`, any `image` node whose `attrs.mediaId` is it), never by matching text;
- the drafts that hold it;
- whether it is the site's logo or favicon.

Revisions other than the published one are history, not use (cms-architecture §13).

**Who sees what:**
- Titles (up to five) only for members who see every page and post. An Author gets the counts.
- A Viewer gets no library (403); another site's file is not found.

**In the drawer**, "Move to trash…" shows the file's usage with the consequences:
- the published pages that stop showing it at once;
- that it can be restored for 30 days, and is deleted for good after;
- that a copy a browser already has may still show for a while (ADR 0023 §8; no revocation is promised).

**At commit,** `trashMedia` counts the usage again inside its own transaction, and the result names it: "Moved to the trash. 1 published page or post no longer shows it." M6-4's behaviour is unchanged: trash and restore flush `media:{id}` at once.

### 9. The cache

| Change | Flushed | What a visitor sees on the next request |
|---|---|---|
| Unpublish | `entry` and `routes` at once, and **`list:{type}` at once** (since M7-1: a list linking to a page that is gone would send visitors to a 404) | The path is not found; the blog, its pages and the term archives no longer list it; links to it are plain text; `/` shows the site's name if it was the Home page |
| Trash, restore, purge | Nothing (only drafts are trashed or restored) | No change |
| Media trash and restore | `media:{id}` and `site:{id}:media` at once (M6-4) | The image disappears or comes back |

The integration tests record the tags each public read applies (the entry, the blog, the archive, and a page linking to the post) and check that the operation's own events flush every one of them.

## Not in M7-1

- **M7-2:**
  - scheduling;
  - the system actor, after which the purge could be recorded;
  - `schedule` and `cancel_schedule` are defined in `lifecycle.ts` but not offered.
- **M7-3:** revision history and restoring a revision, unchanged here.
- **M8-3:** menus must omit trashed and unpublished entries.
- **M8-4:** the sitemap reads the same published-only lists.
- **M8-5:** redirects ("redirect this URL to…") on unpublish or after a trash.
- **Later:**
  - warning, before an entry is deleted for good, about pages that link to it. Its links become plain text (M5-6), and that is all;
  - a site whose `site_settings.not_found_entry_id` points at a trashed entry. No screen sets it in V1; the key is `ON DELETE SET NULL`.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Unpublish and trash are two steps | The brief; taking a page off the site is confirmed on its own | Two clicks to throw away a live page | Editors ask for "unpublish and trash" |
| Restore refuses a taken address | No silent new address; the person decides which page keeps it | One more step when an address was reused | — |
| A page goes with its subtree, at one moment | No live page under a trashed one; a restore brings back what went | A page cannot be trashed while a page below is published | — |
| "Trashed together" = the same `deleted_at` | No new column, no migration of data; one `clock_timestamp()` per trash | Two trashes of one subtree in the same microsecond would be one (they serialize on locks, so they cannot) | A trash needs an id of its own (undo history) |
| Restore follows a moved parent | The tree's address is the canonical one; live children moved the same way | The restored address may differ from the old one (the success message says where) | — |
| The job moved to the content module | One job; dependencies point one way (content → media) | Media's purge is not a job of its own any more | — |
| The purge is not recorded | As media's (ADR 0022); no system actor until M7-2 | The activity log does not say when the purge ran | M7-2 adds the system actor |
| Warn, never refuse, before trashing media in use | Trash is restorable; refusing would block cleaning up | A published page can lose an image after a warning | — |
| Lists flushed at once on unpublish | A stale list would link to a page that is gone | One more recomputation of the blog after an unpublish | — |

## Evidence

- **`tests/integration/content-lifecycle.test.ts`** (28, real Postgres through PgBouncer):
  - **unpublish:** public reads before and after, with the tags each read applied all flushed at once by the operation's events; revisions, dates and draft kept; republish keeps the date; the Home page; pages below; who may; a failed record leaves it published;
  - **trash:** refused when published, for the Home page, for a subtree with a published page or the Home page below; the address is free and reused unsuffixed; out of the lists; one moment for the subtree; who may (an Author's own posts, no pages, a Viewer refused); a failed record trashes nothing; the form's message;
  - **restore:** as drafts, never republished; refused, naming the address, for the root or a page below (nothing restored); the parent must be restored first; following a moved parent; refused after 30 days or when the parent is gone;
  - **races, in rounds:** two restores wanting one address; restore against a move; trash against a new page below; restore against the purge;
  - **purge by hand:** the subtree, cascades, the log kept, terms and media kept;
  - **`trash.purge`:** what is due goes, other sites and organizations included; recent and restored entries stay; media purged in the same run; not recorded; a live child (made by hand) keeps its parent back and is reported; the Home page is never deleted; a failed batch is retried whole; the registry and daily list;
  - **lists:** the trash filter, an Author's own;
  - **media warning:** published and draft use, logo, another site's draft ignored, trashed entries ignored, titles hidden from an Author, Viewer 403, another site's file not found, the trash's own message, the page's image back on restore.
- **Mutation checks:**
  - removing the parent's share lock in `createEntry`, or looping `lockSubtree` only once, fails the trash-against-new-page race on its first round;
  - removing the purge's settings lock still passes the restore-against-purge race (the rows are locked in the same order, so they queue), so that lock serializes, but is not the only guard.
- **Other suites:**
  - `isolation.test.ts`: the four operations, their forms and the usage lookup, with B's entry, file and slug;
  - `audit.test.ts`: the four new events written by real changes;
  - `rls.test.ts`: the lookup returns organization ids only;
  - `media-library.test.ts`: the trash's usage.
- **Unit tests:**
  - `lifecycle.test.ts`: the transition table and the rights;
  - list-query (the trash filter), audit vocabulary and wording, cache events (unpublish flushes lists at once).
- **`tests/e2e/content-lifecycle.spec.ts`** (5):
  - unpublishing a post and publishing it again, seen by a visitor;
  - a page and its child to the trash; restore refused while another page holds the address, then restored; deleted for good;
  - the Home page and a published child blocking the trash;
  - an image in use: the warning, the page without it, restored;
  - the posts' trash on a phone.

  Repeated 5 times: 25 of 25 passed. The M6-3 and M6-4 specs confirm the media trash in its new dialog.

## Addendum (M7-2, 2026-10-16): the purge is recorded; scheduled entries

ADR 0025 has the details.

- **`trash.purge`** now records each entry it deletes as `entry.deleted` by the system actor "Forge (trash cleanup)", in the batch's transaction. That record carries `below` (the pages deleted with it) and `afterDays`. A record that cannot be written deletes nothing.
- **A scheduled entry** cannot be unpublished or trashed; its schedule is canceled first. The editor's trash section says so.
- **Unchanged:** the state machine's M7-1 transitions, two-step unpublish and trash, restore refusing a taken address, and the subtree rules.
