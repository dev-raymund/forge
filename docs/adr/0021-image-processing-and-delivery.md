# ADR 0021: Image processing, variants and their storage, `/media/{key}`, the account avatar

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-15 |
| **Issue** | M6-2 (v1-github-issues.md) |
| **Decisions touched** | Plan §8 (variants, delivery), §14 (storage limit); ADR 0006 (single host, `/media`), ADR 0008 (storage; addendum), ADR 0020 (the upload protocol), ADR 0004 (the avatar, moved from M2-4), ADR 0005 (a hold that outlasts a function, like a job's claim) |

## Context

Since M6-1, an upload is checked (size, stored type, magic bytes) and becomes `ready`, but nothing processes an image and nothing serves media. Plan §8 asks for synchronous variants in `completeUpload`:
- **sharp**, with `limitInputPixels`, auto-rotated, all metadata stripped;
- **widths** 400 (a cropped square), 800, 1600, 2400, never above the original, as WebP.

It also asks for a `/media/{key}` route handler with immutable caching, `nosniff`, a sandbox CSP and allow-listed types only.

M6-1 handed over four more things: process between the checks and the final transaction, delete variants wherever the original is deleted, decide whether variants count towards storage, and serve only ready, untrashed rows' objects. M2-4 moved the account avatar here.

## Decision

### 1. Processing (`modules/media/processing.ts`)

| Step | What |
|---|---|
| Library | `sharp` 0.35.5, now a direct dependency (the version Next already installs; one copy) |
| Decode | Only the format the upload was checked as (sharp's own reading must agree). `failOn: "error"`: a corrupt or truncated file is refused. 30 s per variant at most. sharp's operation cache is off |
| Pixel limit | 50 megapixels (`limitInputPixels`), checked from the header before anything is decoded, so a decompression bomb (a 60 MP image in 300 KB) is refused at once. For an animation, its frames together |
| Orientation | Auto-rotated from EXIF. Width and height are the image as shown (orientations 5–8 swap them) |
| Metadata | None in any variant: EXIF (GPS too), XMP, ICC, IPTC. sharp keeps none unless asked to; the tests read each variant back |
| Format | WebP, quality 75 |
| `thumb` | A square of 400, cropped from the centre; smaller (the shorter side) when the image is smaller |
| `w800`, `w1600`, `w2400` | Each width the image reaches, never above it |
| `w{width}` | The image's own width, when it is narrower than 800, so a small image still has a variant without metadata |
| Animation | A GIF or WebP animation stays animated in every variant, frame for frame |
| The original | Kept as uploaded (for reprocessing later), never served (§5): its metadata is still in it |

- **Who may fail:** a failure that is the file's (not decodable, too many pixels, too many frames, too slow) refuses it: `failed`, and every object deleted. Any other failure is ours.
- **Timing:** each image's processing time is logged with that instance's p95 over its last 50 (`media image processed`). The logs carry every duration, from which the p95 across instances is computed (V1 has no metrics store).

### 2. How a completion processes (`completeUpload`, ADR 0020 extended)

1. **The hold.** The uploader's pending upload is claimed (`processing_token`, `processing_until`: 15 minutes, longer than any Vercel function may run, like a job's claim, ADR 0005):
   - A second completion of the same upload waits for the first and answers what it settled. After 20 s it says "still being finished, try again".
   - A hold that ran out belongs to a completion that died. The next completion takes over, and first deletes everything that one named.
2. **The checks** of M6-1, unchanged: size, stored type, the first 4 KB.
3. **An image is processed** in memory.
4. **Write-ahead:** the planned variants (keys, sizes) are written on the row, still `pending`, before any is stored. Every object ever written is named by its row: the next completion and `uploads.cleanup` can always find it.
5. **The variants are stored** (create-only, `image/webp`, immutable cache headers). All writes settle before anything else happens, so a failure is handled only once nothing is still in flight.
6. **One transaction:**
   - the storage limit for the variants' real bytes (§3);
   - `pending → ready` with the width, height, variants and their bytes, only while still holding the upload;
   - `media.uploaded`.
7. **Failures:**

   | What | Result |
   |---|---|
   | The file's fault | `failed` first (only by the holder, so nothing can make it ready afterwards), then the original and every variant deleted |
   | Over the storage limit | The same, with `code: "LimitExceeded"` (the action answers `LimitExceeded`) |
   | Ours: storage down, a variant not stored, the database or the audit write failing | The variants it wrote are deleted and the hold let go. Still `pending`, and completing again starts over. Variants that could not be deleted stay named on the row |
   | A completion that dies | Its hold runs out, and the next completion or the cleanup deletes what it named |

   An asset is `ready` only when its original and every variant are stored. `/media` serves nothing of a pending row (§5), so nothing incomplete is ever exposed.

**A PDF** is checked and becomes `ready` as in M6-1: it never reaches the image processor.

### 3. Variants count towards the storage limit (decided)

- **What counts:** a media item counts `size_bytes + variant_bytes` while it is not `failed`.
  - The original counts once, from the request (the reservation).
  - The variants count from the moment the upload becomes `ready`.
- **The check:** at that moment, `assertLimit(tx, org, "storage", variantBytes)` runs in the same transaction, under the organization's lock.
  - Only the variants are added: the original is already in the usage, so nothing is counted twice.
  - Concurrent completions take turns, and each counts what the others committed. Tested in rounds, two completions with room for one image's variants: exactly one is ready.
- **Over the limit:** the upload is refused and gives back everything, original included.
- **Representation:** `variants` (JSONB: name, `webp`, width, height, bytes, storage key) and `variant_bytes` (their sum, a column the usage sum reads). Migration 0008.
- **Unchanged:** Free 1 GB, Pro and the trial 20 GB.

### 4. Deleting variants

`objectKeysOf(row)` is the original and every variant on the row. Everything that deletes a media item's objects uses it:
- **refusals:** the completion's;
- **failures:** the clean-up after a failure;
- **takeover:** a takeover of a dead completion's leftovers;
- **`uploads.cleanup`:** it also leaves alone any upload a completion holds now, and finds it settled on its next run.

M7-1's purge must use it too (hand-off). Deleting a missing object is not an error, so every one of these can be retried.

### 5. `/media/{key}` (`src/app/media/[...key]/route.ts`)

- **What it serves:** only what an authoritative record says is public now (`deliverableObject`):

  | Key | Served when |
  |---|---|
  | `o/{org}/s/{site}/m/{media}/v{n}/{variant}/{name}.webp` | A variant of a ready, untrashed image |
  | `o/…/original/{name}.pdf` | The file of a ready, untrashed document |
  | `u/{user}/a/{avatar}/thumb/avatar.webp` | The user's current avatar (§6) |

  - **Org media** is looked up by `public_media_object(media id, key)`, a SECURITY DEFINER function owned by `forge_lookup` (migration 0009, the arrangement of 0002 and 0007).
    - It answers only for ready, untrashed items, and only for keys that are that item's variants or document.
    - The request has no tenant context, and RLS is unchanged.
    - The organization and site in the key must be the record's, and the object is read through the record's own storage scope.
  - **Not served:**
    - an image's original (EXIF/GPS);
    - anything pending (a sent but unchecked object exists before its check), failed, trashed or replaced;
    - another media id, site, organization, version or variant spliced into a key;
    - any other key shape;
    - a segment that decodes to a separator (`%2F`, `%5C`), so there is one spelling per object.
- **Response headers:**

  | Header | Value |
  |---|---|
  | `Content-Type` | The record's, from the allow-list (WebP, JPEG, PNG, GIF, PDF; never HTML, script or SVG); never the request's or what the stored object claims |
  | `Cache-Control` | `public, max-age=31536000, immutable` |
  | `CDN-Cache-Control` | The same, for CDNs that cache only on their own header |
  | `X-Content-Type-Options` | `nosniff` |
  | `Content-Security-Policy` | `default-src 'none'; sandbox` |
  | `Content-Disposition` | PDFs `inline`, images `attachment` (plan §8; an `<img>` shows either), with the key's server-made file name |

- **Not found** is one answer, `404`, `Cache-Control: no-store`. A pending upload's URL starts working the moment it is ready, and no CDN keeps the earlier 404.
  - A ready record whose object is gone is a 404 too, and is reported.
  - Storage down is a `503` with no detail.
- **The proxy** gives `/media` its own surface (`decideRoute` → `media`).
  - Cookies and `Authorization` are stripped before the route runs, as for sites.
  - No session cookie is ever renewed on it: a public, cacheable response must never carry `Set-Cookie`.
  - It sets the same `nosniff` and sandbox headers.
- **A CDN domain later** is `MEDIA_PUBLIC_BASE_URL`, unchanged.

### 6. The account avatar (moved from M2-4)

The avatar is uploaded and processed like other media, but belongs to the user, not to an organization, so it has no media row.

- **Flow:**
  1. `requestAvatarUploadAction(file)`: an image (JPEG, PNG, WebP, GIF; the 20 MB image limit). It returns a presigned PUT (10 min, signed for type and size, create-only) to `u/{user}/a/{avatar}/original/avatar.upload`, in the user's own storage scope (`storageForUser`, ADR 0008 addendum).
  2. The browser PUTs the file to it.
  3. `completeAvatarUploadAction(avatarId)`: checks the stored type and the first bytes, processes the image into a 400 square (`thumb`, WebP, no metadata), then points `users.image` at its `/media` URL.
- **Nothing untracked:** before an object can exist, an `avatars.collect` job is queued for it an hour ahead. When it runs, it deletes the object unless that object is then the user's picture.
  - The original is therefore always deleted; completion also deletes it at once.
  - A replaced picture is queued for now, in the same transaction that replaces it.
- **Where the picture comes from:** the browser never names the URL. `/update-user` still takes the name only.
  - A Google sign-up's picture URL is never shown (`ownAvatarUrl`: only the user's own `/media/u/{id}/a/…`), and is replaced by the first upload.
  - The header's account menu and the account page show the picture, or the initials as before.
- **Storage limit:** avatars count towards none. They are nobody's media, and one per user is kept.
- **Account deletion** is disabled in V1. If it is enabled, it must queue the current avatar's collection.

### 7. `<ResponsiveImage>` (`src/themes/_kit/components/responsive-image.tsx`)

- **Output:** `srcset` (every variant but the square thumbnail, by width), the layout's `sizes`, the intrinsic `width`/`height`, `loading="lazy"`, or eager with `priority`. React then preloads it.
- **Fallback `src`:** the first width of at least 800.
- **No sources:** nothing at all, never a broken image.
- **Inputs:** it takes resolved URLs; `responsiveSources(variants, urlOf)` in `@/modules/media/shared` makes them. Wiring it into the renderer is M6-4's.
- **File name:** kebab-case like the rest of the kit (the issue wrote `ResponsiveImage.tsx`).

### 8. Function duration and memory

- **Duration:** completion (with processing) runs in the function of the page that calls the action. `/account` exports `maxDuration = 60`; M6-3's media pages must do the same (hand-off).
- **Memory:** on Vercel Hobby it is fixed (2 GB, 1 vCPU) and cannot be configured. One decode is bounded by the pixel limit (50 MP × 4 bytes ≈ 200 MB), and sharp's cache is off.
- **Not verified:** none of this has run on a deployment (none exists).

## Policy decisions recorded

| Question | Decision | Why |
|---|---|---|
| Do variants count towards storage? | Yes, their real bytes, checked when ready | They are stored; the brief decided it |
| Animated GIF/WebP | Animated variants, frame for frame | The original is never served, so stills would silently drop the animation; sharp keeps it |
| Images narrower than 800 | One variant at their own width | Otherwise a small image would have no metadata-free full size |
| The thumbnail's crop | Centre | Predictable; `attention` cropping is not defined for animations |
| Is an image's original served? | Never | It holds the uploader's EXIF, GPS included |
| Images opened directly | Downloaded (`attachment`), as plan §8 says; PDFs inline | The plan |
| A second completion of an upload being processed | Waits up to 20 s, then "try again" | Completion usually takes 1–3 s |
| Avatar storage | No quota; one per user; originals never kept | Nobody's media |

## Not in M6-2

- The dropzone and library (M6-3).
- The picker, the image block's editor and renderer, and featured/OG/logo/favicon use (M6-4).
- Trash, restore and purge (M7-1).
- Re-processing existing uploads after a change of settings: there are none yet in production.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Synchronous processing in the completion | Plan §8; no queue or worker in V1 | The completion takes seconds; Next queues a page's actions | Many files at once feel slow: process in a job (`processImage` is written to move unchanged) |
| A hold longer than any function run | One processor per upload without a transaction open over I/O | A completion that dies blocks retries for up to 15 minutes | Crashes are seen in practice: shorter holds with heartbeats |
| Write-ahead variant keys | No object can be untracked | One more write per image | — |
| Quota checked on real variant bytes at the end | Exact; no estimate | A file can be refused after it was sent, when the organization is very near its limit | Users hit it: reserve an estimate at request |
| A lookup function for delivery | RLS unchanged; a key is only good for its record | One more SECURITY DEFINER function | — |
| `/media` stripped of credentials, no cookie renewal | A cached public object must be the same for everyone | Direct visits to media never extend a session | — |
| Avatar objects tracked by delayed collect jobs | No table, nothing untracked | A job per object | — |

## Verified, and not

- **Verified against RustFS (the S3 API) and the local driver, real Postgres:**
  - processing every type: rotation, metadata gone, sizes, animation;
  - every refusal, including a 60 MP image refused from its header;
  - storage and database failures with nothing left behind, including a partial write (mutation-checked: `Promise.all` instead of settling every write leaves an object behind and fails the test);
  - takeover after a dead completion; concurrent completions;
  - quota with variants, including concurrent completions near the limit;
  - cleanup of variants;
  - delivery: every eligible and ineligible case, spliced keys, traversal, storage trouble;
  - the avatar: upload, replace, collect, refusals, another user's id.
- **Verified in a real browser (Chromium, production build, local driver):** the avatar's upload, square, header and `/media` headers, with no cookie.
- **Not verified:**
  - Cloudflare R2;
  - whether Vercel's CDN caches `/media` responses on these headers;
  - the function's duration and memory on Vercel;
  - how browsers' built-in PDF viewers treat a PDF under `sandbox` (Chrome's may refuse to render it inline; then the PDF downloads instead).

  M6-4 makes PDFs linkable from content and should check that in a real browser.

## Evidence

- `tests/integration/media-processing.test.ts` (21, both drivers): phone photo (GPS, rotation), every type and ladder, animation, PDF, refusals, a variant not stored, a partial write, the audit failure, the takeover and the wait, concurrent completions, the quota (exact, over, concurrent), the cleanup of named variants.
- `tests/integration/media-delivery.test.ts` (12, both drivers): headers and bytes, PDF, pending/failed/trashed/unchecked, spliced keys, malformed and encoded keys never reaching storage, a missing object, storage down.
- `tests/integration/avatar-upload.test.ts` (12, both drivers, and the actions and job).
- `tests/integration/rls.test.ts`: the delivery lookup answers only for ready, untrashed variants and documents.
- `tests/integration/isolation.test.ts`: an avatar request naming another user stays the caller's.
- M6-1's suite (`media-uploads.test.ts`) now completes real images.
- Unit tests:
  - `media/processing.test.ts` (the ladder, rotation, metadata, refusals, animation);
  - `_kit/components/responsive-image.test.tsx` (the srcset output, exactly);
  - `auth/account-image.test.ts`;
  - `platform/storage/storage.test.ts` (avatar keys, the user scope);
  - `platform/routing/hosts.test.ts`, `tests/unit/site-addresses.test.ts` (the media surface).
- `tests/e2e/media.spec.ts` (3), `tests/e2e/account.spec.ts` (the picture's input).
