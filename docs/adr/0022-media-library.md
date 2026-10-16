# ADR 0022: The media library: dropzone, folders, search, the drawer, the trash and `trash.purge`

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-15 |
| **Issue** | M6-3 (v1-github-issues.md) |
| **Decisions touched** | Plan §8 (folders, search, delete), §13 (`media.*` permissions), §16 (`trash.purge`), §19 (`/…/media`), §20 (`media:{mid}` tags); builds on ADR 0020 (the upload protocol; addendum: the settled policy) and ADR 0021 (processing, delivery), ADR 0010 (audit), ADR 0009 (own/any) |

## Context

M6-1 and M6-2 made uploads real: request, send straight to storage, complete (checked, processed). Nothing let a person upload, find, organise or delete media. M6-3's criteria:

- **Dropzone:** multi-upload with per-file progress and retry.
- **Views and folders:** grid and list; a folder sidebar (one level) to create, rename, delete-empty and move.
- **Search and filters:** trigram search over title, file name and alt; filter by kind and folder; sort by newest, name, size.
- **Detail drawer:** edit title, alt and caption; copy the URL; trash and restore; `trash.purge` removes objects after 30 days.
- **Ownership:** Authors manage their own uploads only.

## Decision

### 1. Who may

| | Permission | Roles |
|---|---|---|
| See the library (`/…/media`, the nav's "Media") | `media.upload` or `media.update.any` | Owner, Admin, Editor, Author. A Viewer sees "no access" and no link |
| Upload | `media.upload` (M6-1) | Owner–Author |
| A file's details, its folder | `media.update.own` / `.any` | An Author changes their own uploads; Editors up change anyone's. An upload whose uploader's account is gone is nobody's own: only `.any` |
| Trash, restore | `media.delete.own` / `.any` | Likewise |
| Folders: create, rename, delete an empty one | `media.update.any` | Editors up. Folders belong to the site, not to anyone |

- **Everyone who sees the library sees all its files.** An Author does too, but the drawer shows other people's files without controls, and the server refuses any change to them anyway.
- **Moving several files is all or nothing:** if one of them is not the member's to move, nothing moves.

### 2. What is listed (`listLibrary`)

- **Only ready files** of this site, in the trash or not. Pending and refused uploads are never in the library; they exist only in the dropzone while it runs.
- **Scope:** every query names the organization and the site, because RLS keeps organizations apart but not two sites of one organization.
- **Search:** over `title || ' ' || original_filename || ' ' || alt_text`, the expression the trigram index covers, case-insensitive. `%` and `_` are matched as typed.
- **Filters:** kind (images or PDFs); folder (a folder, "in no folder", or all). A folder id that is not this site's is no filter at all.
- **Sort:** newest; name (the title, else the file name); size (what it stores, variants included). In the trash, newest means most recently trashed.
- **Paging:** 48 to a page.
- **The query** comes from the URL, every value reduced or dropped (`library-query.ts`, as the content lists').
- **Thumbnails** are the `thumb` variant (a 400 square from `/media`). The drawer's preview is the widest variant up to 1600. The URL to copy is an image's widest variant or a document's file. An image's original is never shown or linked: `/media` does not serve it (ADR 0021).
- **Storage used** is shown from `allowanceOf`, originals and variants: "1.2 MiB of 20 GiB used on the Pro plan".

### 3. The dropzone (`ui/upload-dropzone.tsx` over `ui/upload-queue.ts`)

- **Input:** "Choose files" (the file input) or a drop.
  - It is disabled until the page is interactive, so a choice made before hydration is never silently lost; the M6-2 avatar form now does the same.
  - "Into" chooses the folder; it defaults to the folder being shown. Each file keeps the folder it was added with, retries included.
- **Checking:** each file is checked in the browser with the same rules as the server (`checkFile`). A refused file is never sent, and the server decides anyway.
- **Requests:** files are sent in requests of at most 20, each all or nothing (ADR 0020 addendum). One refused request does not stop the others.
- **Per-file states:**

  | State | Meaning |
  |---|---|
  | Preparing | The request |
  | Uploading | The send to storage, with real progress (XHR); at most three at a time |
  | Finishing / Processing | The server's completion; Processing for an image |
  | Ready | Only when the server says so |
  | Failed | With a reason and, when there is one, a "Try again" |
  | Refused | With the server's or the browser's reason |

- **Answers:**

  | Answer | What the person sees |
  |---|---|
  | `Validation` | The file and the server's reason; no retry |
  | `LimitExceeded` | The plan's words. At request: nothing was reserved, retry possible after making room. At completion: the file is gone |
  | `Conflict` | A retry that sends again while the link is valid (a 412 means it arrived), then completes |
  | `Unavailable` | "Storage is not answering right now", and a retry |
  | Unexpected | "The file was not uploaded" |

  Retries follow the ADR 0020 addendum, which also records the server gap (no link renewal or cancel).
- **No double submissions:** a file with a step in flight never starts a second request, send or completion.
- **The library** re-renders after files become ready. A live region summarises the queue, and never says "done" while anything is going or failed.

### 4. Changing files and folders (`library.service.ts`)

Each change is one transaction with its audit record (seven new events), and returns its cache events:

| Change | Audit | Cache |
|---|---|---|
| Details: title ≤ 200, alt text ≤ 500, caption ≤ 1000 characters; only what changed. A trashed file must be restored first | `media.updated` (which fields) | `media.updated`: `media:{mid}` stale (plan §20) |
| Move one or up to 100 files to a folder of this site, or out of any; the folder share-locked, the files locked | `media.moved` per file moved | none: no public page shows folders |
| Trash | `media.trashed` | `media.trashed`: `media:{mid}` **immediate**. A trashed file's URLs answer 404 at once, so a page still drawing it would show a broken image |
| Restore, into its folder if that still exists | `media.restored` | `media.restored`: immediate |
| Create or rename a folder: 1–100 characters, separators read as spaces, unique in the site | `media.folder_created`, `media.folder_renamed` (with the previous name) | none |
| Delete a folder: only when no file still counts in it (ready or uploading, not trashed). Files in the trash come back in no folder (`ON DELETE SET NULL`) | `media.folder_deleted` | none |

**Folder on upload:** `requestUploads(ctx, files, { folderId })`, also `requestUploadsAction(org, site, files, folderId)`.
- The folder is looked up in the context's site and share-locked while the rows are written, so it cannot be deleted under them.
- Deleting it waits, then sees the uploads and refuses.
- Another site's folder, another organization's, or an unknown id refuses the whole request (nothing reserved). The composite key keeps a file and its folder in one site in any case.

### 5. The trash and `trash.purge` (`purge.ts`, daily)

- **Trash** sets `deleted_at`. The file leaves the library, is no longer served (ADR 0021) and cannot be newly used in content (ADR 0020).
- **Storage:** it still counts towards storage until purged.
- **The purge,** for media in the trash for 30 days, in each organization that has any (a lookup returning ids only, migration 0011), in that organization's tenant context:
  1. **Claim:** a batch is made `failed`, in one statement, rows locked with `SKIP LOCKED`. From then on no restore can win, since restoring needs `ready`, and the files count for nothing.
  2. **Objects:** the original and every variant are deleted (`objectKeysOf`), through each row's own storage scope.
  3. **Rows:** the rows whose objects are gone are deleted.
- **When objects cannot be deleted:** the row stays `failed`, `uploads.cleanup` deletes it later, and the job fails so the failure is seen.
- **Concurrency:** tested in rounds against a concurrent restore. The file ends restored with its objects, or gone; never restored without them.
- **Not audited** (as `uploads.cleanup`): nobody did it, and the trashing was recorded.
- **Entries:** M7-1 adds them to this job.
- **Migrations:** 0010 (a partial index on `deleted_at`) and 0011 (the lookup).

### 6. Pages and limits

- **The page:** `src/app/(admin)/[orgSlug]/sites/[siteSlug]/media/page.tsx`.
  - `maxDuration = 60`: completions and their processing run in this page's function.
  - It bounds the run only. Memory is Vercel's (fixed on Hobby), and nothing has been measured on Vercel.
- **Phones:** the folders stack above the files, and the list view's extra columns hide. A test at 360 px checks there is no sideways scrolling.
- **Keyboard:** each file is a button, the drawer is a dialog (Escape closes it), and every control has a label.

## Not in M6-3

- **M6-4:** the picker, inserting media into content (no new path), featured, OG, logo and favicon, the image block.
- **M7-1:** entries in `trash.purge`.
- **Later:** a server capability to renew or cancel a pending upload (ADR 0020 addendum); drag-and-drop between folders (moving is by selection or from the drawer); nested folders (`parent_id` exists).

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Authors see every file of the site | M6-4's picker will need them; "manage" is the issue's word, not "see" | An Author sees colleagues' uploads | A site needs private uploads |
| Folders are Editors' | They are the site's structure | An Author cannot file their uploads into a new folder (they can into existing ones) | Authors ask for it |
| Trash and restore immediate in the cache | The file stops being served at once | Each trash flushes every page that shows the image | — |
| Purge claims by `failed` first | No restore can bring back a file whose objects are being deleted; reuses `uploads.cleanup` for the remainder | A purged file shows as an upload failure in the database until removed | — |
| No link renewal | The brief: only the current contract | An expired send costs a second reservation for up to 24 h | Users hit the storage limit this way: add renewal |
| The input disabled until interactive | A choice before hydration would be lost without a word | The button is inert for that moment | — |

## Evidence

- `tests/integration/media-library.test.ts` (17, real Postgres, local driver):
  - folder on upload (own site, refused for others, nothing reserved; no deleting a folder under an upload; the real protocol into a folder);
  - the listing (only ready, this site; search with `%`/`_`; kind; folder; none; sort; pages of 48; thumbnails and URLs never the original; storage);
  - roles (Viewer, Author, Editor, orphans), another site's and organization's ids;
  - details, move (all or nothing, audit rollback), trash and restore;
  - folders (unique, empty-only, trashed files);
  - `trash.purge` (30 days, objects, restore after claim, undeletable objects, daily, racing a restore in rounds).
- `tests/integration/isolation.test.ts`: every library operation and form with B's file or folder (205 checks); `rls.test.ts`: the purge lookup; `audit.test.ts`: the seven events written by real changes.
- Unit tests:
  - `media/ui/upload-queue.test.ts` (every outcome and retry, batches, the summary);
  - `media/policy.test.ts` (255 characters, each limit and one byte over, PDF at byte zero);
  - `billing/plans.test.ts` (binary units);
  - `audit/events.test.ts`; `platform/cache/cache.test.ts`; `tests/unit/audit-writer.test.ts`.
- `tests/e2e/media-library.spec.ts` (4):
  - three images and a PDF, search, move to a folder, trash and restore;
  - folder on upload, a refusal in the browser, a refusal by the server, a failed send retried;
  - an Author's own files and others' read-only, a Viewer without access;
  - a phone with the keyboard.

  Repeated 5 times: 35 of 35 passed.

## Addendum (M7-1, 2026-10-16): `trash.purge` purges entries too; the media trash warns

ADR 0024 has the details.

- **The job:** `trash.purge` is now defined in the content module (`content/purge.ts`). It purges entries in the trash for 30 days, then calls `purgeTrashedMedia`, unchanged. The media module keeps the function and `TRASH_DAYS`; the job no longer lives in `media/purge.ts`. Still one daily job, and the same 30 days.
- **The warning:** "Move to trash…" in the drawer asks first. It shows where the file is used (`mediaUsage`, this site only):
  - the published pages and posts that stop showing it at once (featured image, or an image block of the published revision, found in the stored JSON);
  - the drafts that hold it;
  - the logo and favicon.

  Titles appear only for those who see every entry. Nothing is refused.
- **At commit:** `trashMedia` counts the usage again in its transaction, and the message says how many published pages no longer show the file.
- **Not promised:** that copies already cached by a browser or CDN are taken back (ADR 0023 §8).

## Addendum (M7-2, 2026-10-16): the folder selector waits for the page

- **What happened:** the dropzone's "Into" folder selector was usable before the page was interactive. A folder chosen in that moment showed in the field, but the upload went into no folder, because React's state was not listening yet. This is the same failure M6-3 fixed for the file input.
- **Found by:** E2E runs during M7-2. The folder test failed about 1 run in 5 to 1 in 8, and the database showed the files with no folder.
- **The fix:** the selector is now disabled until the page is interactive, like the file input.
- **After the fix:** 18 of 18 runs reached the folder step and passed.
