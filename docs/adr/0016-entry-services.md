# ADR 0016: Entry services: create, save, publish, and the Home page

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-12 |
| **Issue** | M5-3 (v1-github-issues.md) |
| **Decisions touched** | D-13 (entry aggregate), D-27 (cache tags), D-30 (audit); builds on plan §5, §6, §9, ADR 0003 (editor spike), ADR 0009 (permissions), ADR 0010 (audit), ADR 0011 (sites), the M5-1 schema and M5-2 paths and slugs |

## Context

M5-1 verified the content tables; M5-2 added the registry, paths, slugs and `insertWithUniqueSlug`, and stored the Home page at `/`. Nothing wrote entries. M5-3 adds the write paths the editor (M5-4), the renderer (M5-6) and the admin screens (M5-7) stand on. No table changed: there is no migration.

## Decision

### 1. The services

```text
modules/content/
  entry.service.ts        createEntry, saveDraft, createHomePage (for createSite)
  publishing.service.ts   publishEntry
  homepage.service.ts     setHomepage
  tree.ts                 moveSubtree: a path change carried to every page below
  policies.ts             who may (ADR 0009)
  repository.ts           the queries; every one names the organization and the site
  validation.ts           createEntry's input, the draft, a typed slug, a version
  document/               the stored document's contract and pipeline (from spikes/editor, ADR 0003)
  entry-forms.ts          the form handlers; actions.ts the Server Actions (finish → invalidate)
```

Each service takes a `SiteContext`. An entry id is looked up in the context's site (and its organization, and only while the site is not deleted): an id of another site, even of the same organization, is not found, and so is one in the trash. Ids from forms or arguments name things; they never grant anything.

### 2. Who may

| Operation | Permission |
|---|---|
| create | `entries.{type}.create` (pages Owner–Editor, posts Owner–Author) |
| save the draft | pages `entries.page.update`; posts `canActOn("entries.post.update", author)` |
| change a draft's terms | the above and `terms.assign` |
| publish | pages `entries.page.publish`; posts `canActOn("entries.post.publish", author)` |
| credit someone else as author (at creation) | pages `entries.page.update`, posts `entries.post.update.any`; the author must be a member of the organization |
| set the homepage | `site.settings.manage` (Owner, Admin): plan §3 lists the homepage among the website settings |

Keys come from the entry's stored type, never from input. The entry is read before the permission is asked (a post's policy needs its author), so for an id outside the site the answer is NotFound whatever the caller's role, the same as for an id that does not exist.

### 3. createEntry

The type from the registry; the slug from the title (`slugFromTitle`: `untitled` without one), made unique where the entry will live by `insertWithUniqueSlug` (`base`, `base-2`, …, reserved paths skipped); a page's directory is its parent's path (a page of this site, not in the trash), a post's the blog path. Draft version 1 holds one empty paragraph. `entry.created` is recorded. Nothing public changes, so no cache event. The slug is never typed at creation.

Author: the caller, or a member someone with the type's "any" edit right credits. Changing the author later is the sidebar's (M5-7).

### 4. The Home page made with each site

`createSite` (ADR 0011) creates a draft page `Home` at `/` (slug `home`), with its draft, and sets `site_settings.homepage_entry_id`, in its own transaction. The site's `site.created` record covers it: no `entry.created` of its own. Sites made before M5-3 have no Home page; `setHomepage` gives them one. No backfill.

### 5. saveDraft

Only the fields sent are written (`title`, `slug`, `excerpt`, `template`, `featuredMediaId`, `content`, `fields`, `termIds`), with `WHERE version = expected`, and the version moves on by one. A mismatch is a Conflict and writes nothing. Not recorded and not flushed: autosave runs every few seconds, and drafts are not public.

Checked: the document (§7); a typed slug (format, at most 100 characters, and the path it would give not reserved; never suffixed: a slug that collides with another entry's path is refused at publish); fields the type does not have (pages: no excerpt, image or terms; posts: no template); the type's extra fields (none for page and post); terms (each one of this site, of a taxonomy the type uses: `term_ids` has no foreign key); the featured image (of this site: the composite key, turned into a field error). SEO fields are M8's and cannot be saved yet.

### 6. publishEntry

In one transaction, as the issue lists it:

1. lock the entry and its draft (`FOR UPDATE`): two publishes of one entry take turns
2. idempotency: if the published revision came from this draft version, answer as before and write nothing; otherwise a different draft version is a Conflict
3. a `publish` revision: the draft's snapshot (document validated again, terms checked again), numbered after the entry's last
4. the projection: status, title, slug, path, excerpt, image, `published_revision_id`; `published_at` set at the first publish and kept after (it is the entry's date, and lists sort by it); `first_published_at` set once. If the path changed, every page below follows (`moveSubtree`)
5. `entry_terms` replaced by the draft's terms (posts; pages have none)
6. `entry.published` recorded (`type`, `title`, `path`, `revision`)
7. events returned: `entry.published` (with `pathChanged` when a live path changed) and `entry.moved` for each live page below that moved

The path: the Home page stays at `/`; a post is under the blog path; a page under its parent's path, after its chain of parents has been walked: a loop, a missing or trashed page, or a post above it is a field error. Another entry holding the path is a Conflict naming it; a typed slug is never suffixed. A failure anywhere, including the record's, leaves the entry, its revisions and its terms as they were.

### 7. The document

`spikes/editor/schema.ts` and `document.ts` (ADR 0003) are carried into `modules/content/document/` unchanged, plus `emptyDocument` and the person-facing `documentProblem`: the closed allow-list of nodes and marks, link and button `href`s (`http(s)`, `mailto`, `tel`, `/path`, `entry:{uuid}`), YouTube and Vimeo embeds, at most 1 MB and 2,000 nodes, no columns inside columns, unique ids, per-node `v` migration, the trailing empty paragraph trimmed. M5-4 and M5-5 move each node's attributes into the block registry (`src/blocks/*`); the spike keeps its copy for the `/dev/editor` page until then.

### 8. setHomepage

The Home page is the page at `/`, and `homepage_entry_id` names it. In one transaction:

1. lock the site's settings row: two changes of one site's homepage take turns
2. the current Home leaves `/` for an ordinary path where it sits in the tree, from its slug (`home`, or `home-2`, … when taken: a generated suffix, its draft's slug renamed with it), and the pages below it follow (from the top level to under it)
3. the new Home takes `/`, and the pages below it follow (to the top level)
4. `homepage_entry_id` names it; `site.homepage_changed` is recorded (`name`, `title`, `previousTitle`)

The tree does not change: every page keeps its parent. Only a page of this site, not in the trash, can be the Home page. If any page would land on a taken address, the whole change is a Conflict naming it, and nothing moves. Events: `site.configChanged`, and `entry.moved` for every live page that moved.

### 9. Cache and audit vocabulary

- One cache event added: `entry.moved` (a live entry's path changed without it being published again) → its entry tag, `routes`, `config` (for M8-5's redirects); its type's list, stale.
- Three audit events added: `entry.created`, `entry.published` (resource `entry`) and `site.homepage_changed` (resource `site`). An untitled entry is recorded as "Untitled".

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| The entry is read before the permission | A post's policy needs its author; foreign ids answer NotFound | One read before a refusal | — |
| A partial draft | Autosave sends the document and title, the sidebar the rest; neither overwrites the other's fields | No "replace the whole draft" | — |
| Autosave neither recorded nor flushed | Every few seconds; drafts are private | The log does not show edits until publish | — |
| A typed slug that collides is refused at publish, not at save | The address can be taken or freed between saving and publishing; the publish is what holds it | The editor learns of it late | M5-7 wants an early hint: a read-only check |
| Old Home moves within the tree, its children with it | The tree's rules are kept: a page's path is its parent's and its slug | A homepage change moves more URLs than the two pages | M8-5's redirects make it safe for visitors |
| `published_at` kept on republish | Lists sort by it; an edit should not bump a post | A "last published" time is not stored (the revisions have it) | Someone needs it on the entry |
| Homepage needs `site.settings.manage` | It is a website setting (plan §3) | Editors cannot set it | Plan says otherwise |

## Not in M5-3

The editor (M5-4), blocks and the block registry (M5-5), rendering and `resolveRoute` (M5-6), lists, forms, moving pages, changing the author (M5-7), term management (M5-8), unpublish, trash, restore (M7-1), save revisions and history (M7-3), scheduling (M7-2), SEO fields (M8), redirects on a path change (M8-5).

## Evidence

- `src/modules/content/document/parse.test.ts`: the spike's 19 tests and the new ones.
- `src/modules/content/validation.test.ts`: the inputs.
- `src/modules/audit/events.test.ts`, `src/platform/cache/cache.test.ts`: the new events.
- `tests/integration/content-entries.test.ts` (real Postgres): the Home page with each site and its rollback; createEntry (paths, suffixes, reserved, concurrency, parents, types, authors, roles, rollback); saveDraft (fields, conflict, concurrency, every document refusal, typed slugs, type support, terms of other sites and organizations, images of other sites, roles, other sites' entries); publishEntry (revision and projection, republish, idempotency, stale version, concurrency, descendants, taken addresses, injected bad data, Home, rollback at the record, the commit and the terms, roles); setHomepage (both trees, no-op, taken slug, collision, posts, sites without a Home, roles, concurrency, rollback); the forms.
- `tests/integration/isolation.test.ts`: the four forms with B's entry, from B's URL and from A's own site; the content policies; B's content in the fingerprint.
- `tests/integration/audit.test.ts`: the three events are covered by a mutation.
