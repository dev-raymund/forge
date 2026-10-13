# ADR 0019: Categories and tags: managing them, deleting them safely, and keeping the public site fresh

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-14 |
| **Issue** | M5-8 (v1-github-issues.md) |
| **Decisions touched** | Plan §5 (taxonomies), §13 (`terms.manage` / `terms.assign`), §19 (term screens), §20 and D-27 (cache tags); builds on ADR 0010 (audit), ADR 0016 (entry services), ADR 0017 (public content), ADR 0018 (content admin) |

## Context

The `terms` and `entry_terms` tables have existed since M1-1. M5-3 lets a draft hold term ids (`entry_drafts.term_ids`, a uuid array with no foreign key) and publishing copies them into `entry_terms`. M5-6 draws the archives, and M5-7 lets the sidebar tick existing terms. Nothing could create, rename or delete a term, no cache event followed a term change, and deleting a term would leave its id in drafts, whose next publish would then be refused.

## Decision

### 1. Operations and who may

| Operation | Permission | What it does, in one transaction with its audit record |
|---|---|---|
| `createTerm` | a category: `terms.manage` (Owner–Editor); a tag: `terms.manage` or `terms.assign` (Owner–Author) | inserts the term (`term.created`) |
| `updateTerm` | `terms.manage` | the name, slug, description, and a category's parent (`term.updated`, with the old name and slug) |
| `deleteTerm` | `terms.manage` | takes the term out of every draft and off every post, then deletes it (`term.deleted`, with the counts) |
| `listTermsWithUsage` | `terms.manage` | the term screens: each term with its published posts and drafts |

- **Screens:** `/…/posts/categories` and `/…/posts/tags`, linked from the site's nav for those who manage terms.
- **Authors** add tags from a post's settings ("Add a tag"), which is M5-8's third criterion. The new tag is ticked and saved with the draft by autosave, and the editor is not re-rendered, so nothing typed is lost.
- **Assignment** stays the draft's and the publish's (`saveDraft`, `publishEntry`): there is no second save path for terms.

### 2. Integrity

- **The taxonomy** must be one a content type uses (the registry: category and tag, used by posts). The database's CHECK agrees.
- **Slugs** are unique per site and taxonomy (`terms_site_taxonomy_slug_unique`).
  - **Made from the name:** it takes the next free one (`bread`, `bread-2`, …), and retries in a savepoint if a concurrent writer took it.
  - **Typed:** a slug someone types is used as typed or refused with a message, never suffixed, as entries' are.
- **Categories nest one level.** A parent must be a top-level category of the site. A category with subcategories stays at the top level, and a category can never be its own parent. Re-parenting takes the site's settings lock, as page moves do, so two concurrent changes cannot stack a second level. The composite foreign key keeps a parent within the site.
- **Isolation:** every query names the organization and the site. Another site's term (even in the same organization) is "not found" for updating and deleting. As a parent or in a draft it is refused as invalid.
- **Renamed slugs get no redirect;** that is M8-5's. The `term.updated` record keeps the previous slug for it.

### 3. Deleting a term, and the drafts that hold it

`entry_drafts.term_ids` has no foreign key, so deleting a term, in one transaction:

1. locks the drafts that hold the term (`SELECT … FOR UPDATE`);
2. locks the term;
3. takes it out of every such draft (`array_remove`);
4. deletes it: its `entry_terms` go with it (CASCADE), and its subcategories move to the top level (SET NULL);
5. writes `term.deleted` with the number of posts and drafts.

No entry is deleted. Published revisions keep the id in their history. A failure anywhere, the audit record included, leaves everything as it was (tested with a forced audit failure).

**Concurrency.** Saving and publishing lock the draft first, then share-lock the terms they name (`termsOfSite … FOR SHARE`). Deleting takes the same order: drafts, then the term. So no two of them wait on each other in a loop, and every race ends in one of two ways:

- **The save or publish commits first.** The delete then waits, sees the term in the draft, and takes it out. The `entry_terms` row goes with the term.
- **The delete commits first.** The save or publish then finds the term gone, and is refused with "A category or tag chosen here no longer exists, or is not this site's. Untick it, or reload the page." Nothing is written.

In neither case does a reference to a deleted term remain (tested in repeated rounds of both races).

**The draft's version is not moved** by the cleanup. It is not anyone's edit:
- An editor open on the draft keeps saving its text without a conflict.
- An editor that still sends the deleted term (because its user ticked terms in that session) is refused with the message above, so it cannot put the term back.
- Bumping the version would turn every open editor on every post that carried the term into a conflict. The refusal already prevents the lost update, and costs less.

### 4. Freshness: the `term.changed` event

`{ type: "term.changed", siteId, entryIds }`:

- **immediate:** `site:{id}:routes`, and `site:{id}:entry:{eid}` for each published post carrying the term. Past 200 such posts it is `site:{id}`, the site umbrella, instead.
- **stale:** `site:{id}:list:post`, as a publish marks it (D-27, unchanged).

| Change | What becomes fresh |
|---|---|
| Created | The routes: a cached "no such archive" at its address goes |
| Renamed, re-slugged, description, parent | The routes (the archive's address, name and description) and each post that shows it (its name and link) |
| Deleted | The routes (the archive is gone) and each post that carried it (it no longer shows the term); the lists stale |
| A draft's terms changed | Nothing: the live archive and the posts change when the draft is published (`entry.published`, ADR 0017) |

The integration tests record the tags each public read applies (`resolveRoute`, `loadEntry`, `loadPostList`). They then check that each real operation's events flush them, and flush nothing of another site. The E2E test shows it in a browser, on the next request: a rename moves the archive and the post's link, and a delete removes both. Another site's archive at the same address is untouched throughout.

## Not in M5-8

- Redirects from old term slugs (M8-5).
- Term archives in the sitemap (M8-4).
- Restoring a revision whose terms were deleted since (M7-3; the revision keeps their ids).
- Merging terms, and bulk actions.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Tags creatable with `terms.assign` | The criterion: Authors add tags while writing; the catalog unchanged | An Author can add tags nobody else wanted | Tag sprawl: an approval, or tags from a fixed list |
| Clean drafts in the delete's transaction | No foreign key on `term_ids` (an array), and a stale id blocks publishing | A delete touches every draft that holds the term | Drafts' terms move to a join table |
| Lock order drafts → term everywhere | No deadlocks between delete, save and publish | Saves that send terms lock their draft row a little earlier | — |
| No version bump on cleanup | Open editors keep working; a stale id is refused anyway | An editor's sidebar may list a deleted term until reloaded | Users find the refusal confusing: push a notice to open editors |
| Per-post entry tags, capped at 200 | Exact freshness for normal terms; one tag for huge ones | A huge term flushes the site's cache | — |
| Lists stale-while-revalidate | D-27 as designed | One request may show the old list | Make `list:` immediate everywhere (ADR 0017) |

## Evidence

- `tests/integration/content-terms.test.ts` (real Postgres):
  - **creating:** slugs from names and their suffixes; a typed slug refused when taken; every invalid input; concurrent creates of one name, and of one typed slug;
  - **permissions:** each role, and the sidebar's form path;
  - **renaming and moving:** the nesting rules, and concurrent re-parentings;
  - **deleting:** drafts, links, subcategories and entries after a delete; rollback on an audit failure; delete racing a save and a publish, in repeated rounds; a stale editor refused, then saving again;
  - **isolation:** two sites of one organization, and another organization;
  - **freshness:** each operation's events against each public read's tags; the 200-post cap; a draft's term change leaving the live archive alone until published.
- `src/platform/cache/cache.test.ts`, `src/modules/content/term-validation.test.ts`, `src/modules/audit/events.test.ts`; `tests/integration/audit.test.ts` (every event written by a mutation).
- `tests/e2e/content-terms.spec.ts` (production build): the category screen (add, subcategory, a taken slug, rename, delete with its counts, drafts cleaned); an Author's "Add a tag" with the text and excerpt kept; the public archives after a rename and a delete, and another site untouched; tags on a phone.
