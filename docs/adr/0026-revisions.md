# ADR 0026: Revisions: Save, the history, restore, and the conflict dialog's overwrite

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-16 |
| **Issue** | M7-3 (v1-github-issues.md) |
| **Decisions touched** | Plan §6.3 (Save, Conflict), §9 (Revisions, Revision restore), §14 (manual revisions kept per entry); cms-architecture §15 (D-15: full-snapshot revisions); builds on ADR 0003 (autosave and the conflict dialog), ADR 0010 (the audit writer), ADR 0016 (publishing), ADR 0019 (terms), ADR 0024 (the lifecycle), ADR 0025 (scheduled revisions) |

## Context

M7-3's criteria:
- **"Save"** creates a `save` revision, deduped by content hash; capped by the plan; publish revisions always kept.
- **The history drawer:** number, kind, author, time, label, live marker.
- **`restoreRevision`** copies a revision into the draft (+ a `restore` revision), never publishes, and flags missing media.
- **Testing:** restore → the draft equals the revision's content; the published version is unchanged.

Hand-offs:
- **M5-4 (ADR 0003):** the conflict dialog's third choice, overwrite, "after saving the other version as a `save` revision".
- **M5-8 (ADR 0019):** a restored revision may name terms deleted since; drop them, and say so.
- **M7-1 (ADR 0024):** restoring from the trash is not restoring a revision; a trashed entry's history is reachable once it is restored.
- **M7-2 (ADR 0025):** `scheduled` revisions are in the history; the one that went live is the entry's `published_revision_id` (no `publish` copy).

The schema already had what the plan describes (migration 0001): `entry_revisions` with the kinds `save`, `publish`, `scheduled` and `restore`, a `label`, `content_hash`, `source_draft_version`, no `UPDATE` grant, and `DELETE` kept "for retention pruning". **No migration was needed.**

## Decision

### 1. One service, one transaction each (`content/revisions.service.ts`)

Each operation:
- **locks the entry, then the draft:** the order Publish, scheduling and the scheduled job take;
- **checks the draft's version** against the one the editor holds;
- **writes** the revisions, the draft and the record together;
- **leaves all of them as they were on any failure:** a step, the record, or the commit.

| Operation | Who | What it writes |
|---|---|---|
| `saveRevision(entry, { version, label? })` | the type's edit right | a `save` revision of the draft at `version` |
| `restoreRevision(entry, { revisionId, version })` | the type's edit right | the draft as it was (kept as `save`, §3), the revision copied into the draft (`version + 1`), a `restore` revision; `entry.revision_restored` |
| `overwriteDraft(entry, { replaceVersion, draft })` | the type's edit right | the version it replaces (kept as `save`), then the editor's draft through `saveDraft`'s own checks; `entry.draft_replaced` |
| `listRevisions(entry, before?)` | who may see the entry | — (30 at a time, newest first) |
| `getDraftHead(entry)` | who may see the entry | — (the draft's version, who saved it, when: the conflict dialog) |

**Who:**
- An entry the caller may not see is not found, as another site's is: a page to an Author, another Author's post, an entry in the trash.
- One they may see but not change is refused: a Viewer.
- Every id is looked up in the context's organization and site. A revision is looked up in that entry too, so another entry's revision, even on the same site, is not found.

**What none of them touches:**
- the entry's projection (status, title, path), its `published_revision_id` and its published terms;
- a schedule's time and its frozen revision.

So nothing public changes: **no cache event is returned or flushed**. What visitors see changes only by publishing (or the scheduled job).

### 2. Save, deduped and capped

**Save:**
- "Save" in the editor saves what is typed first (autosave's `flush`), then keeps that version.
- **Deduped:** when the latest revision already holds exactly the draft, it answers with that revision's number ("Already in the history as revision 3"). "Exactly" compares every field a person can change: title, slug, excerpt, featured image, template, document, fields, SEO and term ids. It is a hash of canonical JSON, so equal documents compare equal however their keys are ordered. A content hash alone would treat a changed title as nothing new.
- **A label** the person types ("Before the redesign") makes a new revision even when the content is the same, unless the latest one already has that label: they mean to find this point again by its name. Labels the system writes (§3) never do.
- **A stale version** (another tab saved since) is refused with `NOT_THE_LATEST`: a revision never holds content the person did not see.
- **Not recorded in the activity log:** like autosave, it changes nothing public, and the revision row itself (immutable, with who and when) is the record.

**The cap** (plan §14 "Manual revisions kept per entry": Free 20, Pro and the trial 100; `PLANS[plan].manualRevisions`, `billing.manualRevisionsKept`):
- **Manual revisions** are `save` and `restore`. Beyond the plan's number, the oldest are deleted in the same transaction (`pruneManualRevisions`).
- **Always kept:** `publish` and `scheduled` revisions. A scheduled one may be, or may have been, the live one (ADR 0025), and a queued job names it.
- **Never deleted:** the live revision. None of the manual kinds ever is the live one, and the query excludes it anyway.
- **A downgrade** prunes an entry the next time it gets a manual revision. Nothing is pruned in the background.

### 3. Restore: into the draft, checked as a draft is now, never published

The revision is copied into the draft (a new version), then a `restore` revision ("Restored from revision N") records it. **Before that, the draft as it was is kept** as a `save` revision ("Kept before revision N was restored"), unless the latest revision already holds it. Nothing the draft held is lost, and a restore can itself be undone from the history.

The old revision is never changed: revisions have no `UPDATE` grant.

**Nothing in a revision is trusted because it was valid once:**

| What | Rule | When it no longer qualifies |
|---|---|---|
| Document | The closed schema and its limits (1 MB, 2,000 nodes), block versions migrated (`parseDocument`); nothing of another site (`assertOwnReferences`) | Refused: "Revision N cannot be restored: …", nothing written |
| Title, slug, excerpt, template | The draft's own rules (`draftSchema`); the type's fields | Refused, as above |
| Address | A slug other than the draft's must give an address the entry may have where it is now: today's parent and blog path; not reserved; held by no other entry. The Home page stays at `/` | Refused, naming the address and its holder. Never a suffix (ADR 0024's restore rule) |
| Terms | Each still a term of the site, of a taxonomy the type uses (share-locked after the draft, the order a term's deletion takes) | **Left out**, and the message says how many (the M5-8 hand-off) |
| Images and links in the document | — | **Kept as written, and flagged:** "2 images in it are no longer in the media library…". A trashed or deleted image is shown as unavailable in the editor and left out of the page, as it already is when an image is trashed after it was inserted (ADR 0023). Restoring the image from the media trash brings it back. Nothing the person wrote is removed |
| Featured image | — | **In the media trash:** kept (the composite key allows it), flagged, not shown. **Deleted for good:** removed (the key cannot point at it), flagged |
| Parent, author, status | The entry's, not the revision's (revisions do not hold them) | — |

**The live version:**
- A published entry stays published at its live revision; the editor shows "Published, with unpublished changes".
- A scheduled entry stays scheduled with its frozen revision: the job publishes that one, not the restored draft (tested, also racing the job).
- Publishing the restored draft is a separate, ordinary Publish.

**The trash:** an entry in the trash has no history to list or restore (not found). Restoring it from the trash (ADR 0024) brings back the entry; its history is then there again. The screens say "Restore revision N" and "Copy revision N into the draft?", never "Restore" alone.

### 4. The conflict dialog's overwrite (plan §6.3's third choice)

1. **Autosave meets a newer version:** the editor goes read-only, as in M5-4.
2. **The dialog asks the server** who saved the draft and when (`getDraftHead`): "The newer version was saved by Ana Reyes at 16 Oct 2026, 10:42", or "by you, in another tab or window". Its three choices: Copy my changes, Load the latest version, and **Overwrite with my version…**
3. **Overwrite asks for confirmation**, saying what happens: that version is kept in the history first, so it can be restored; the draft then becomes what the editor shows; nothing is published.
4. **The server**, in one transaction:
   - locks the entry and the draft;
   - checks the draft is still at **exactly the version the dialog named** (`replaceVersion`);
   - keeps that version as a `save` revision ("Kept when the draft was overwritten"), credited to whoever saved it (their words) and deduped as in §2;
   - writes the editor's draft through `saveDraft`'s own checks (`writeDraft`, against the draft as it is now: new images must be ready images of this site, a new featured image too, terms of the site, slug rules);
   - records `entry.draft_replaced` with the kept revision's number.

   A refusal at any step writes nothing, the kept revision included.
5. **A version saved after the dialog named one is never overwritten unseen.** The server refuses with `CHANGED_AGAIN`. The dialog shows the newer save and the person confirms again.
6. **What is written:** everything the editor shows. The title, the document, and every draft field the sidebar shows, changed in this tab or not. The draft then is what the person saw when they chose to overwrite. Fields the editor does not show (SEO, custom fields) stay as the server has them.
7. **Success is shown only after the commit, with the new version.** Then:
   - autosave `adopt`s that version (saved; the old local buffer forgotten; nothing saved twice);
   - the editor is editable again;
   - the notice names the kept revision.

   On any failure the editor, its local buffer and the dialog stay as they were.
8. **On a published or scheduled entry,** only the draft changes, as for any save. The frozen revision of a schedule is never touched.

**Not an unconditional save:** the overwrite is optimistic concurrency with a second, explicit token. Two overwrites of one version: one wins, the other is told it changed again. An overwrite racing an ordinary save: one wins (tested in rounds).

### 5. The screens

**Editor header:**
- **History:** every member who can open the editor.
- **Save:** those who may edit.

**History dialog** (`editor/revision-history.tsx`; a dialog like the media library's "drawer"):
- **Each revision:** number, kind (Saved, Published, Scheduled, Restored), label, title, who (or "A former member"), when.
- **Markers:** "Live" for the revision visitors see; "Publishes …" for a schedule's frozen revision, in the site's time zone.
- **Loading:** 30 at a time, with "Show older revisions".
- **Save with a label:** a form at the top.
- **Restore…:** an inline confirmation per revision. Restore saves what is typed first, then the editor loads the draft again (a full load, after autosave is flushed and disposed). The server's message is carried across in `sessionStorage`.
- **States:** loading, error with "Try again", and "Restoring…". Buttons are disabled while a request is on its way, and the dialog does not close mid-request.
- **Keyboard:** usable throughout (tested: open, Restore, confirm). A Viewer gets the list without Restore or Save.

**Conflict dialog** (`editor/conflict-dialog.tsx`): §4. "Copy my changes" and "Load the latest version" are as they were.

### 6. Audit

Two events, recorded in the same transaction as the change (so a failed record leaves no change):
- `entry.revision_restored`: `{ type, title, path, revision }`. "Ada restored revision 3 of the post Rye into its draft."
- `entry.draft_replaced`: `{ type, title, path, keptRevision }`, labelled "Draft overwritten". "Ada overwrote the draft of the page About; the version it replaced is revision 7." The key follows the vocabulary's rule for past tenses ending in -ed.

The writer itself is unchanged. The system actor (ADR 0025) is not used: every revision operation is a person's.

## Not in M7-3

- **Compare UI:** a SHOULD after V1 (plan §1).
- **Autosave checkpoint revisions:** removed from V1 (plan §1).
- **Restoring parent or author:** revisions hold neither.
- **A preview of a revision's content in the history:** the list shows its title. Preview is M7-4's.
- **Later milestones:** M7-4 and everything after.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Restore keeps the current draft first | "Do not delete history users may need to recover work": a restore can be undone | Two revisions per restore (one when the draft is already in the history) | Histories get noisy |
| Dedupe on every editable field, not the content hash alone | A changed title is a change | A tiny hash computed per save | — |
| Images and links that are gone are kept and flagged; terms dropped | The issue says "flags missing media"; M5-8 says drop terms. Removing blocks would discard what someone wrote | A restored draft can hold an image that shows as unavailable | Authors want a "remove missing" button |
| An address held by another entry refuses the restore | No suffix, no silent rename (ADR 0024) | The person changes the other entry's slug, or restores another revision | — |
| The overwrite names the version it replaces | Never overwrite a version the person was not told about | One more round trip when someone saves meanwhile | — |
| The overwrite writes every field the editor shows | The draft becomes exactly what the person saw | Another tab's change to, say, the excerpt is replaced, but it is in the history | Real-time collaboration |
| Restore reloads the editor | The editor's state (document, sidebar) starts from the server's draft; autosave is flushed first, so nothing is lost | A page load | The editor can swap its whole state in place |
| `save` and `restore` count toward the cap; `scheduled` does not | `scheduled` revisions can be live, and jobs name them | A site that schedules a lot keeps more | Storage (cms-architecture §15's estimate) |
| The live `scheduled` revision stays `scheduled` in the history, with the Live marker | ADR 0025's choice; the marker shows what is live whatever the kind | "Scheduled" and "Live" on one line | — |

## Evidence

- **`tests/integration/content-revisions.test.ts`** (34, real Postgres through PgBouncer):
  - **Save:** the draft at its version, deduped, labels, a stale version refused, nothing recorded or flushed; the cap on Free (20, the oldest pruned, the publish revision kept) and then on Pro.
  - **The history:** order, kinds, labels, names (a former member's kept without a name), the live marker, the frozen schedule's time, pages of 30.
  - **Who:** an Author (own posts only, no pages), a Viewer (reads, restores nothing), another site of the same organization, the trash.
  - **Restore:**
    - the draft equals the revision (all fields); the old revisions are unchanged; the kept draft and the `restore` revision are written; recorded;
    - the entry row and the public page are unchanged; nothing flushed; publishing afterwards makes it live; the form's message;
    - refusals: a stale draft, another entry's revision, a non-id;
    - deleted terms dropped; trashed and deleted images and a trashed link flagged and kept; a trashed featured image kept, a deleted one removed; the result published;
    - an address held by another entry, a reserved one, the draft's own slug not checked again; an invalid document;
    - a scheduled entry (the job publishes the frozen revision); the Home page stays at `/`.
  - **Overwrite:**
    - kept and credited to whoever saved it, then written, recorded, nothing public changed, and the kept version restorable;
    - a version saved after the dialog's is refused and nothing written;
    - refused content (a trashed image as the featured image or in the text, an invalid document, a bad slug) writes nothing, not even the kept revision;
    - on published and scheduled entries; through the form.
  - **Races, in rounds:**
    - two saves from one version;
    - an overwrite against a save;
    - two overwrites;
    - a restore against a save;
    - a restore against a publish (the live version is never the restored one; one publish revision per publish);
    - a restore against the scheduled job.
  - **Failures:** the revision insert, the draft update, the record, or the commit failing (restore and overwrite), and Save's insert: nothing changes.
  - **Mutation checks:**
    - without the overwrite's version check, three tests fail;
    - without restore keeping the draft first, two fail.
- **`isolation.test.ts`:** the five services, the two reads through their actions, and the three forms, with B's entry, from A's site and from B's URL: not found, B unchanged.
- **Unit:**
  - autosave `adopt`;
  - the audit vocabulary and its two sentences;
  - the plans' `manualRevisions`.
- **E2E `content-revisions.spec.ts`** (2, production build; 10 of 10 over five repeats):
  - Save and "Already in the history"; the history by keyboard; a labelled save; restore by keyboard; the editor reloaded with the restored draft; visitors keep the published version until "Publish changes"; a Viewer's read-only history.
  - Two tabs: the conflict dialog names the other save; overwrite confirmed; a save in the other tab while the dialog is open is refused, then the overwrite goes through; the replaced version is revision 1; the editor saves on from the new version.

## Addendum (M7-4, 2026-10-16): previewing a revision

ADR 0027 has the details.

- **"Preview"** on each revision in the history draws it as it was saved, in the site's theme, in a frame. Its number, kind, label, who, when and markers are named, with a note that viewing it changes nothing.
- **"Restore this revision…"** beside it is this ADR's restore, unchanged: confirmed, version-checked, and keeping the draft first.
- **Viewing writes nothing** (no revision, no record, no flush).
