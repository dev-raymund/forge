# ADR 0020: Media uploads: request, send to storage, complete; the storage limit; the daily cleanup

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-15 |
| **Issue** | M6-1 (v1-github-issues.md) |
| **Decisions touched** | Plan §8 (media), §14 (storage limit), §16 (`uploads.cleanup`), §21 Phase 6 (the Server Actions); builds on ADR 0001 (RLS), ADR 0005 (jobs), ADR 0008 (storage driver; addendum), ADR 0009 (`media.upload`), ADR 0010 (audit), ADR 0016 (content references) |

## Context

The `media_assets` and `media_folders` tables, their constraints and their RLS have existed since M1-1. M1-5 built the storage seam (`storageFor`, `mediaObjectKey`, `createUpload`, `head`, `readRange`) and a development route that issued upload targets to anyone. M5-5 made content check that a new image is a `ready` media item of its site.

Nothing created media rows, so no upload was real. Plan §8 defines the protocol:

1. `requestUploads` checks the files and the storage limit, creates `pending` rows and returns presigned PUTs (10 minutes).
2. The browser PUTs each file.
3. `completeUpload` HEADs the object (the size must match), sniffs the first 4 KB (magic bytes) and deletes on a mismatch.

A daily `uploads.cleanup` removes `pending` rows older than 24 hours.

## Decision

### 1. Two Server Actions, one service each

| | Who | What |
|---|---|---|
| `requestUploads(ctx, files)` / `requestUploadsAction(orgSlug, siteSlug, files)` | `media.upload` (Owner–Author) | Checks every file (§2) and the organization's storage limit (§5), all or nothing. Creates one `pending` row per file and returns a target per file: a presigned PUT for 10 minutes, signed for exactly that content type and size, that creates its object once. |
| `completeUpload(ctx, mediaId)` / `completeUploadAction(orgSlug, siteSlug, mediaId)` | `media.upload`, and only the uploader | Checks what storage holds (§4). The row becomes `ready` (recorded as `media.uploaded`), or the object is deleted and the row becomes `failed`. |

- **Server Actions**, as plan §21 (Phase 6) lists them, not route handlers. Next checks a Server Action's origin, so no cross-site page can start an upload with someone's session. The `/api/app/media` JSON route of that phase is the picker's (M6-3/M6-4), not this.
- **Who and where:** the organization and the site come from the page's URL through the resolver (membership, site of the organization), as every admin action's do. The browser's file list and media id are input to check. The storage key is always the row's own, made here. Nothing the browser says is taken as true: not that it uploaded, not what it uploaded, not where.
- **No upload passes through the app's functions.** The browser sends bytes straight to the storage target. With the local driver, that target is the app's signed `/api/storage/local/{key}` route, which stands in for S3 in development.
- **No user interface in M6-1.** The dropzone that calls these actions is M6-3's, and the picker's upload is M6-4's. Both are listed in their issues.

### 2. What may be uploaded (`modules/media/policy.ts`, client-safe)

| | Types | Largest |
|---|---|---|
| Images | JPEG, PNG, WebP, GIF | 20 MB |
| Documents | PDF | 25 MB |

- **Refused:** everything else, including SVG, HTML, video, archives and HEIC; an empty file; a size that is not a whole number of bytes; a file with no name.
- **The type is the browser's declared one,** and only a provisional claim: completion checks it against the file's own first bytes. Matching is exact; no type is inferred from the file name.
- **Megabytes and gigabytes are binary** (1024² and 1024³ bytes).
- **The 50-megapixel limit is M6-2's,** because it needs the image decoded (`limitInputPixels`).

### 3. Keys

`o/{org}/s/{site}/m/{mediaId}/v1/original/{name}.{ext}` (`mediaObjectKey`, plan §8):

- The **media id** is new (UUIDv7) for each file.
- The **extension** comes from the declared type, never from the file name.
- The **name** is a hint only: ASCII words from the file name joined by hyphens, at most 60 characters, or `file`. So `../../etc/passwd.png` is `passwd.png` to show and `…/original/passwd.png` as a key.
- The **display name** (`original_filename`) is the name's last path segment, without control or text-direction characters. A name longer than 255 characters is refused rather than cut.

Two uploads of one name get two keys.

### 4. Completion checks what storage holds, not what was promised

1. **The row:** of this site (organization and site in the query; RLS covers only the organization), not trashed, uploaded by the person completing it.
   - Anyone else's upload, another site's, an unknown id, or one whose uploader's account was deleted (`uploaded_by` NULL, so nobody's own): "not found".
   - Already `ready` or `failed`: the same answer again (a retry), with no new audit record.
2. **The object** (`head`): none means the file has not arrived. That is a `Conflict`, and the row stays `pending`, so the client can send it again within the 10 minutes and complete again.
3. **Size:** must equal the declared size. The store also enforces it through the signature; this check catches a store that does not.
4. **Stored content type:** must be the declared one.
5. **The first 4 KB** (`readRange`) must carry the declared type's signature:

   | Type | Signature |
   |---|---|
   | JPEG | `FF D8 FF` |
   | PNG | `89 50 4E 47 0D 0A 1A 0A` |
   | GIF | `GIF87a` or `GIF89a` |
   | WebP | `RIFF` …. `WEBP` |
   | PDF | `%PDF-` at byte 0 |

   - Anything else is refused: HTML sent as PNG, too short to tell.
   - A real file of another allowed type is refused with what it is: "photo.png is a JPEG file, but was sent as PNG. Give it the right extension and upload it again."
6. **Refused:** the row becomes `failed` first (committed, and from `pending` only), then the object is deleted.
   - If that delete fails, the row stays `failed`, never `ready`, and the cleanup deletes the object later.
   - The reason is answered; it is not stored.
7. **Accepted:** `pending → ready`, from `pending` only, and the `media.uploaded` record, in one transaction. An audit failure rolls the completion back: the row stays `pending` and completing again works.

**Not checked:** whether the whole file is well formed, and malware. M6-2 decodes images; PDFs are served as documents with M6-2's headers.

### 5. The storage limit

**What counts** (`assertLimit(tx, org, "storage", Σ declared sizes)`), plans in `modules/billing/plans.ts`:

| Plan | Limit |
|---|---|
| Free | 1 GB |
| Pro and the trial | 20 GB |

- **Usage** is the sum of `size_bytes` of the organization's media that is not `failed`:
  - `pending` counts from the request: a reservation, which completion only accepts at exactly that size;
  - `ready` counts;
  - trashed counts until M7-1's purge removes the object.
- **A failed upload gives its bytes back at once.** An abandoned one gives them back when the cleanup expires it.
- **The race:** `assertLimit` locks the organization's row first. Concurrent requests in one organization take turns, each counting the others' reservations, so they can never together pass the limit. Tested in rounds, five requests at once for the last room: exactly one each time.
- **Message:** "The Free plan includes 1 GB of storage, and these files would take this organization past it (1004 MB used)."
- **Index:** `media_assets_org_usage_idx` (organization, `status <> 'failed'`) keeps the sum off a full scan.
- **Variants:** M6-2's do not count yet; the plan meters the declared originals. A hand-off asks M6-2 to decide.

### 6. Lifecycle and `uploads.cleanup` (daily)

```
requestUploads ──▶ pending ──completeUpload, file as declared──▶ ready ─▶ (M6-3 trash, M7-1 purge)
                     │ ╲
                     │  ╲──completeUpload, file not as declared──▶ failed (object deleted)
                     ╰──── 24 h, never completed ── uploads.cleanup ──▶ failed ──▶ object and row removed
```

The job (`modules/media/cleanup.ts`, registered in `DAILY_JOBS`) works in four steps:

1. **Finds the organizations** with an upload not `ready` that is older than 24 hours. It uses `organizations_with_unfinished_uploads(before, limit)`, a SECURITY DEFINER function owned by `forge_lookup`, the token lookups' arrangement (migration 0007).
   - It returns organization ids only.
   - `forge_lookup` may read only rows that are not `ready`.
   - `forge_app` can execute it but cannot become `forge_lookup`.
2. **In each organization's own tenant context,** expires its old `pending` uploads to `failed`, in one statement. From then on no completion can make them `ready` (it only settles `pending` rows), so an object is never deleted from under a ready row.
3. **Deletes the objects** of its old `failed` uploads, each through `storageFor` the row's own organization and site, so a key outside its prefix is refused.
4. **Deletes the rows** whose objects are gone.
   - A row whose object could not be deleted is kept; the job then fails (so it is retried and visible) and the next run tries again.
   - It stops starting organizations after 30 seconds (the daily route has 60), and the next run carries on.

- `ready` media is never touched.
- **Failed uploads are removed too,** not only the plan's "pending older than 24 h". A failed row's object can come back: a still-valid link can recreate it after a refusal deleted it. Removing the row with its object leaves nothing behind.
- **Index:** `media_assets_unfinished_idx` (`created_at`, `status <> 'ready'`) serves the lookup.

### 7. Retries and failures

| What happens | Result |
|---|---|
| The browser retries a PUT that had succeeded | 412; the file stays as sent; completing works |
| The link is used again after completion, with other bytes of the same size and type | 412; the checked file is untouched (ADR 0008 addendum) |
| `requestUploads` is retried | New rows and targets; the unused ones expire and are cleaned (each holds its reservation until then) |
| Two completions of one upload at once | Both answer `ready`; one row change, one record |
| Completion before the file arrived | `Conflict`; still `pending` |
| Completion races the cleanup | `ready` with its object, or `failed` and later removed; never `ready` without its object (tested in rounds) |
| Storage unavailable when requesting | `Unavailable`; signing happens inside the transaction, so no row is left reserving storage |
| Storage unavailable when completing | `Unavailable`; still `pending` |
| The database refuses the insert, or the commit after signing | An error; no row; the signed links were never returned |
| The audit write fails on completion | Rolled back; still `pending` |

### 8. Content may use only ready images of its own site

- **Image blocks:** M5-5's check of a new image in a document (this site, `ready`, not trashed) now also requires `kind = 'image'`, because a PDF is a media item too.
- **Featured image:** a new featured image in `saveDraft` gets the same check (`assertUsableImages`).
  - Until now only the composite key held it to the site, so a `pending` or `failed` upload of the site could have been set.
  - The cleanup would then have nulled that featured image (ON DELETE SET NULL).
- **Unchanged:** what a draft already holds is not checked again, and publishing still refuses another site's image. Moving these checks behind a media-module API remains M6-4's hand-off.

### 9. Audit and cache

- **`media.uploaded`** (resource type `media`; kind, file name, size) is written when an upload becomes `ready`, in the same transaction. Requesting is a reservation, not activity, and a refused upload leaves no line.
- **No cache event:** a new upload is in no content yet. Content can point at it only after it is `ready` and a draft is saved and published, which flush as before (ADR 0017). The tests mock `next/cache` and check that no tag or path is flushed during the whole protocol.

## Policy decisions left open (recorded, not invented)

| Question | M6-1's provisional answer | Who decides |
|---|---|---|
| How many files one request may hold | 20 (a bound on one request's work; the plan names none) | M6-3, with the dropzone |
| How long a file name may be | 255 characters, refused beyond | M6-3 |
| GB and MB | Binary (1024³, 1024²) | M11 (billing copy) |
| A mislabelled file (a JPEG named `.png`) | Refused with what it is, not relabelled | Revisit if users hit it |
| A PDF whose `%PDF-` is not at byte 0 (readers tolerate some leading bytes) | Refused | Revisit if real files hit it |
| Whether variants count towards storage | Not yet (they do not exist) | M6-2 |
| Re-issuing a target for an existing pending upload (rather than a new request) | Not offered: the client asks again | M6-3 |
| Retention of refused rows | Removed with the expired ones after 24 h | — |

## Not in M6-1

- **M6-2:** processing (`sharp`, variants, dimensions, megapixels); the `/media/{key}` route, which must serve only `ready` items' objects (a pending object exists before it is checked); the avatar.
- **M6-3:** the library: dropzone (progress, retry), folders, search, metadata, trash and restore.
- **M6-4:** the picker and the image block.
- **M7-1:** purge of trashed media and their objects.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Server Actions, not JSON routes | Plan §21 Phase 6; origin checked by Next; one authorization path | Next queues a page's Server Actions, so N completions run one after another | Completion (with M6-2's processing) is slow for many files: a route handler with an origin check |
| Reserve the declared size at request | The quota race is closed under the organization lock, before any byte moves | Abandoned uploads hold their bytes up to 24 h | Users hit the limit with abandoned uploads: release on the target's expiry |
| `pending → failed` before deleting | No completion can make a row `ready` while its object is being deleted | One more write per refusal | — |
| Create-once targets (`If-None-Match`) | A checked file can never be replaced through its own link | R2 must honour the signed header (unverified); CORS must allow it | R2 does not honour it: shorten links and re-check on serve |
| Exact type match | Simple, and the object is stored under that type | Mislabelled files are refused | See above |
| A SECURITY DEFINER lookup for the cleanup | RLS stays as it is; only organization ids cross tenants | One more function owned by `forge_lookup` | More cross-tenant jobs (M7-1 purge): one generic "organizations with work" lookup |
| Failed rows removed after 24 h | No orphan objects; the library stays clean | The failure is not kept for support | Support needs it: an audit event for refusals |

## Cloud storage: verified and not

- **Verified against RustFS (the S3 API)** and the local driver, in `tests/integration/storage.test.ts` and `tests/integration/media-uploads.test.ts`:
  - presigned PUT with signed type, size and `If-None-Match`;
  - 412 on a second PUT;
  - a refused size or type; `head`, a range read, idempotent delete.
- **Not verified:** Cloudflare R2, real browsers against R2's CORS, and R2's enforcement of the signed `If-None-Match` and content length. The runbook (`docs/runbooks/environments.md` §4) runs both suites against an R2 test bucket before first use. Passing RustFS is not taken as proof of R2.

## Evidence

- **`tests/integration/media-uploads.test.ts`** (35 tests; real Postgres; both drivers, the S3 one on RustFS), covering:
  - the happy path for all five types;
  - spoofed and mislabelled types;
  - the target's restrictions and create-once;
  - completion before arrival;
  - a size mismatch;
  - concurrent completions;
  - storage unavailable at each step;
  - audit failure rollback;
  - the cleanup, and the cleanup racing a completion;
  - type, size and count validation;
  - keys from hostile names;
  - roles and the uploader-only rule, and orphans;
  - another site of the organization and another organization;
  - non-ids;
  - database failure before and at commit;
  - the limit (what counts, all or nothing, the last byte, plan change, bytes given back);
  - the quota race in rounds;
  - content refusing pending, failed, PDF, trashed and other sites' media as image and as featured image;
  - the actions' answers;
  - the job's failure and retry;
  - nothing flushed from the cache.
- `tests/integration/isolation.test.ts`: completion and requests with B's ids (as Owner and as Viewer), file fields naming B, and B's media in the fingerprint.
- `tests/integration/rls.test.ts`: the lookup function returns organization ids only, and only for unfinished uploads past the cutoff.
- `tests/integration/audit.test.ts`: `media.uploaded` is written by a real completion.
- `tests/integration/content-paths.test.ts`: migrations 0005–0007 apply over existing content.
- `tests/integration/storage.test.ts`: the contract with create-once targets.
- Unit tests:
  - `src/modules/media/policy.test.ts`: types, sizes, signatures, names, keys;
  - `src/modules/billing/plans.test.ts`: the storage limit and its words;
  - `src/modules/audit/events.test.ts`;
  - `tests/unit/audit-writer.test.ts`.
- `tests/e2e/storage.spec.ts` and `cron.spec.ts`: the development route is gone; the local upload route refuses unsigned PUTs and malformed keys; the daily cron enqueues `uploads.cleanup`.
