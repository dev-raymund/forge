# ADR 0023: Images in use: the picker, the image block, featured images, the logo and favicon

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-15 |
| **Issue** | M6-4 (v1-github-issues.md) |
| **Decisions touched** | Plan §6 (the image block), §8 (picker; logo and favicon "sizes produced from the image at upload"), §20 (`media:{mid}` tags); builds on ADR 0003 (the editor, its block registry), ADR 0017 (the closed renderer), ADR 0018 (the entry sidebar), ADR 0020–0022 (uploads, processing and delivery, the library) |

## Context

After M6-3, media could be uploaded, processed, served and managed, but nothing used it. M6-4's criteria:

- **Picker:** a modal (library + upload), reused across the admin.
- **Image block:** `mediaId`, alt override, caption, size and link, rendered with `ResponsiveImage`. Missing or trashed media renders nothing.
- **Featured image** on posts; the **OG image** field (SEO, M8-4); **logo and favicon** in site settings, with favicon sizes generated.
- **Composite keys** keep another site's media out.
- **Testing:** an E2E that inserts an image in a page, then finds a live `srcset` served from `/media`.

## Decision

### 1. The picker (`media/ui/media-picker.tsx`, `GET /api/app/media`)

**The modal.** `MediaPicker({ orgSlug, siteSlug, open, onOpenChange, onPick, title, description })`, from `@/modules/media/shared`. The image block, the block's panel, the featured image, the logo and the favicon all use this one component.
- **Lists only:** images that are ready, not in the trash, and of this site. Search, folder filter and "Show more" (pages of 48).
- **States:** loading, error with "Try again", and empty.
- **Thumbnails:** each is the image's `thumb` variant, never the original.
- **Keyboard:** each image is a button ("Choose {name}"); Escape closes.
- **Phones:** two columns.

**Choosing and uploading stay separate.** Choosing hands the caller the image (`PickedImage`), and nothing is saved until the caller saves.
- "Upload new images" (a `<details>`) is the M6-3 dropzone (`UploadDropzone`) with `imagesOnly`:
  - its `accept` lists the image types;
  - a PDF is refused in the browser;
  - the server's rules and the upload service are unchanged (no new upload path).
- When a file is ready, the list reloads and the image can be chosen. Uploading never chooses it.

**The route.** `GET /api/app/media?org=&site=&q=&folder=&page=` returns `{ items, hasMore, folders, canUpload }` with `no-store`.
- It calls `listLibrary(ctx, { …, kind: "image" })`, the library's own query and permission (Owner–Author).
- The org and site in the query grant nothing: no session gives 401, another organization or an unknown site 404, a Viewer 403.
- It is read-only.

### 2. The image block

**One model:** the registry's `image` block, attributes unchanged since the M0-5 spike. M6-4 adds:
- `extension.ts`: an atom node;
- `node-view.tsx`: the block in the editor;
- `render.tsx`: the block on the public site;
- the panel's hints;
- `editable: true`.

**Inserting.** The slash menu's "Image" `asks: "media"`.
- The picker opens, and the block is inserted only when an image is chosen, so no block exists without a `mediaId`.
- Its id is a UUIDv7 from the unique-ids extension, kept through save, publish and reload.

**The properties panel** is generated from the schema:
- "Image" uses a new `widget: "media"`: the chosen image's name and "Choose another image". It is never a text field.
- Alternative text (≤ 500), caption (≤ 1000), size (Text width / Wide / Full width), and link (a URL or a page of the site, as a button's link).
- An emptied field is `null`, not `""`. An emptied alt text therefore means "the image's own", not "decorative" (`emptied()` in `panel/fields.ts`).

**Previews in the editor are loaded only when asked for.**
- **When the editor opens,** each image block shows its name, size and caption, and loads nothing.
- **"Show previews"** (on a block or the featured image) loads the thumbnails for this editing session. Choosing an image in the picker does the same, since the picker the person opened already shows them.
- **Only `thumb` variants** of this site's images are loaded, from `/media`. Nothing third-party is loaded, as before (ADR 0003).
- **An image the editor does not know any more** (trashed, or not this site's) says "This image is no longer in the media library. It is not shown on the site. Choose another one." The block is kept, id and all.

**The server.**
- **Saving** checks every *new* image (ready, not trashed, an image, this site's). A PDF, a pending upload, a trashed image or another site's image refuses the save, and nothing is written.
- An image already in the draft is not checked again (M5-5): trashing an image never makes an unrelated edit unsavable.
- **Publishing** refuses a pointer to another site.
- **Autosave, recovery, conflicts and read-only mode** are the editor's as before.
- **Draft versions:** the server bumps the version on every save. The editor saves only when the document changed, so selecting a block or opening and closing the picker writes nothing (E2E).

### 3. On the public site

**The render context** has `resolveImage(mediaId)`.
- `loadEntry` reads the published revision's images (`publicImages`): usable images of this site only.
- An id it does not resolve draws nothing: no `<figure>`, no `<img>`, and the rest of the page is drawn. It is not reported as a fault.
- The block never carries a URL.

**`renderImage`** emits `<figure class="forge-image forge-image--{size}">`, containing `<ResponsiveImage>`, an optional `<a>` and an optional `<figcaption>`. Fixed elements only, and the XSS corpus covers them.
- **`srcset`:** only the image's real `w{n}` variants (`isWidthVariant`), never the thumbnail, the logo, the favicons or the original.
- **Size:** `width`/`height` are the image's intrinsic size, so the page does not jump while it loads.
- **`sizes` per size:** `(min-width: 48rem) 48rem, 100vw`; `(min-width: 72rem) 72rem, 100vw`; or `100vw`.
- **Alt text:** the block's if set, else the image's own.
- **The link** resolves as a button's does. A page that is not live drops the link, not the image.
- **Loading:** lazy.

**Sizes on the page (theme kit CSS).**
- **Text width:** the text's measure.
- **Wide and full width:** they leave the measure for the width of the page's content (`min(--forge-content-width, 100vw − 2 gutters)`; all of it in the wide templates), never past the screen. Full width also loses its corners.
- **Not drawn:** an image as wide as the screen beyond the content container. The default templates do not centre their measure, so that would need a template change; it is left for later.
- **Phones:** no sideways scrolling (E2E at 360 px).

**The featured image** (`<FeaturedImage>`) is drawn above a post's text in Studio and Journal, loaded at once (`priority`). A page has none.

**The logo** (`<Brand>`) is in both themes' headers: the `logo` variant with its size, and the site's name as its alt text. Without a logo, the header shows the name.

### 4. Variants for the site's logo and favicon

**Generated at upload, for every image** (plan §8: "favicon sizes produced from the image at upload"), with M6-2's write-ahead and quota rules. They count towards the storage limit.

| Key | Size | Format | Note |
|---|---|---|---|
| `logo` | Fitted inside 640 × 240, never enlarged | WebP q90 | The first frame of an animation |
| `fav32` | 32 × 32, cropped to a square from the centre | PNG (palette, level 9) | The first frame |
| `fav180` | 180 × 180, cropped to a square from the centre | PNG (palette, level 9) | The first frame (Apple touch icon) |

- **Serving:** `/media` serves them with their own type (`image/png` for the favicons) through the existing lookup (`'image/' || format`). There is no new media route.
- **The original** is still never served.
- **Content variants are unchanged** (`thumb`, `w800`/`w1600`/`w2400`). The site's variants never reach a content `srcset`.
- **Images uploaded before M6-4** have no such variants. Choosing one as the logo or favicon is refused with "uploaded before … could be made from it. Upload it again". The variant set is not backfilled.

### 5. The featured image

- **The slot** in the post sidebar (M5-7's `data-testid="featured-image"`) has "Choose an image", a preview (once previews are shown), "Change image" and "Remove".
- **Saving:** the choice goes with the draft fields (`featuredMediaId`) through `saveDraft`. It checks a new id as a usable image of this site, and the composite key `entry_drafts_featured_media_fk` checks it again.
- **Publishing** copies it into the revision and the entry (`publishEntryAction`, unchanged).
- **Read-only** members see it without the buttons.

### 6. The logo and favicon (`sites/imagery.service.ts`)

`setSiteImage(ctx, "logo" | "favicon", mediaId | null)` and `submitSetSiteImage` / `setSiteImageAction` (the role bound by the page).

- **Who may:** `site.settings.manage` (Owner, Admin).
- **Which image:** the server's `siteImageRefusal`: ready, not trashed, an image of this site, with the role's variants. Anything else, another organization's included, gets the same answer: "Choose an image of this site's media library."
- **The write:**
  - `site_settings.logo_media_id` / `favicon_media_id`, with the settings row locked;
  - the same image again writes nothing;
  - the settings `version` is not raised, because these columns are set from a picker at once and the other forms do not carry them.
- **Records:** `site.settings_changed` with `group: "images"` and `fields: ["logo"]` or `["favicon"]`, in the change's transaction.
- **Cache:** `site.configChanged` flushes `site:{id}:config`.
- **On the settings page:** Logo and Favicon sections, each showing what is set (or that the image is no longer in the library), with the picker and "Remove".
- **On the public site:** `loadPublicSite` resolves them (`siteImagery`) as `imagery: { logo, favicon }`.
  - The theme gets the logo.
  - The page's head gets `<link rel="icon" sizes="32x32" type="image/png">` and `<link rel="apple-touch-icon" sizes="180x180">` on the pages a theme draws (live and Coming soon).
  - A trashed one disappears, since the read is tagged with its `media:{id}`.

### 7. The OG image: M8-4's

The issue's criterion says "OG image field (SEO, M8-4)", and the field, its resolver and its output are M8-4's. M6-4 builds nothing SEO, and SEO is not done.

What M8-4 can use:
- **The picker** (`MediaPicker`, with a title such as "Choose an image for sharing").
- **`usableImageIds`**, to check a new id on save.
- **`publicImages`**, to resolve it at render time. Its widest `w{n}` gives an absolute URL (`MEDIA_PUBLIC_BASE_URL`, defaulting to `${APP_ORIGIN}/media`).

What M8-4 must do itself:
- `seo.ogImageId` (in `entry_drafts.seo` and `site_settings.seo`) is JSON, with **no foreign key**, so it must be checked on save as the featured image is.
- An unusable one must draw no OG tag.
- The page's read must be tagged with its `media:{id}`.

### 8. The cache: the page and the image's own URL

**The page.**
- Every public read that draws an image tags it:
  - `loadEntry` uses `media:{id}` for each image in the published revision and the featured image;
  - past 50 images (`ENTRY_MEDIA_TAGS_MAX`), it uses the site-wide `site:{id}:media` instead;
  - `loadPublicSite` tags the logo's and favicon's.
- The media events now carry the site, and they flush its `site:{id}:media` as well:

  | Event | Flush |
  |---|---|
  | `media.trashed`, `media.restored` | Immediate |
  | `media.updated` | Stale |

- **Result:** trashing or restoring an image changes every page that draws it on the next request (integration-tested with the recorded tags, and E2E).
- **Other changes that affect output** flush through their own events:
  - a featured image changes only with a publish (`entry.published`);
  - a logo or favicon change flushes `site:{id}:config`.

**The image's own URL** (`/media/{key}`) is a different matter:
- **What changes at once:** a trashed image's variants answer 404 from the next request that reaches the function (ADR 0021). Locally and in CI, with no CDN, that is the whole story (E2E).
- **What can linger:** responses are `public, max-age=31536000, immutable`, so a copy already cached by a CDN (Vercel's, in production) or a browser can keep being served until evicted. That holds for whoever has the URL.
- **So:** Forge stops *drawing* a trashed image at once, but cannot *revoke* a URL already handed out. This is not claimed otherwise anywhere.
- **Not verified on Vercel:** `x-vercel-cache` behaviour is on the runbook's checklist (§4 step 6).
- **Not done, and why:**
  - **Purging the CDN on trash.** Vercel's CDN can purge by tag: a `Vercel-Cache-Tag` header on the response, then `dangerouslyDeleteByTag()` from `@vercel/functions` (Vercel docs, "Purge CDN cache"). It needs a new dependency and a test on Vercel, and it still leaves browsers' copies, so it is noted here.
  - **Shortening caching for everyone.** That would cost every image request, so it is not done either. Global caching is unchanged.

### 9. PDFs in the browser

**Tested in Playwright's Chromium (headless):** opening a PDF's `/media` URL downloads it rather than showing it. The test asserts the download: `price-list.pdf`, starting with `%PDF-`. The file is served as M6-2 serves it:
- `application/pdf`;
- `inline`;
- `Content-Security-Policy: default-src 'none'; sandbox`;
- `nosniff`.

**Nothing in the security policy is loosened** to make a viewer work.

**The fallback:** the library's drawer offers "Download" next to "Open" for a PDF (`<a download>`). Whatever a browser does with the inline file, the person gets it. The server's file name (`price-list.pdf`) wins over the link's.

**Not tested here:** Chrome, Firefox and Safari with their real viewers. They stay on the runbook's post-deployment checklist. The open question is whether each displays a sandboxed PDF inline or downloads it.

**PDFs in content:** a PDF is never an image (the picker, the block and the server refuse it). Linking to one from content (as a link to its `/media` URL) is left for later, when a file block is wanted.

### 10. The composite keys (AC4)

The image references with a column of their own have a composite foreign key from migration 0002:
- `entry_drafts_featured_media_fk`;
- `entries_featured_media_fk`;
- `site_settings_logo_fk`;
- `site_settings_favicon_fk`.

Each is `(site_id, x_media_id) → media_assets (site_id, id) ON DELETE SET NULL`. A write that bypasses the services fails on them with another site's image (integration-tested by constraint name for the draft, the logo and the favicon).

A revision's `featured_media_id` has no key: it is history, copied from a draft that had one.

Image ids inside documents (`mediaId` in JSON) have no key. The services check them (§2), and the renderer resolves only this site's (§3).

## Not in M6-4

- **M8-4:**
  - the OG image field and its output;
  - the SEO defaults' image;
  - JSON-LD's logo.
- **M7-1:** entries in `trash.purge`; what purging does to pages that still point at an image (they draw nothing).
- **Later:**
  - CDN purge of a trashed image's URL (§8);
  - a file/PDF block;
  - images as wide as the screen in the text templates;
  - replacing an image's file (plan §8, SHOULD after V1);
  - variants for images uploaded before M6-4.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| Logo and favicon variants made for every image at upload | The plan's rule ("at upload"); any image can be chosen at once, and nothing is generated on a settings save | About 3 small files more per image (tens of KiB, counted in storage) | Storage per image matters more than choosing any image |
| Images from before M6-4 refused as logo/favicon | No backfill job in a milestone that may not add infrastructure; the refusal says what to do | One re-upload | Many sites hit it |
| Editor thumbnails only once asked for | The issue's rule: no media previews without an explicit action | One click per session to see thumbnails | The rule changes |
| The block's emptied alt text is null | "Empty: the image's own" as the field says; a decorative image is one whose own alt text is empty | Alt can't be emptied for one use while the image has its own alt text | Editors ask for per-use decorative images |
| Logo/favicon don't raise the settings version | Set at once from a picker; the other forms would otherwise conflict after every logo change | Two people changing the logo at once: the last one wins | Never: both see what was saved |
| Over 50 images: one site-wide tag | Tag lists stay bounded | Any image change of the site flushes those few large pages | — |
| No CDN purge | No new dependency or untested platform call; browsers keep copies anyway | A trashed image's URL may answer from a CDN until evicted | Takedowns must be immediate: tag responses, purge on trash |

## Evidence

- **`tests/integration/media-images.test.ts`** (14, real Postgres, real uploads and processing, local driver):
  - **the picker's route:** images only; scope; no original; Author 200, Viewer 403, another organization or site 404, no session 401;
  - **image blocks on a published page:** real variants, exact `sources`; never the thumbnail, logo, favicon or original; the draft is not shown;
  - **block ids** through save, publish and save;
  - **refusals on save:** PDF, pending, trashed, another site's;
  - **trash and restore:** recorded tags, immediate flush; the page without the image, then with it;
  - **more than 50 images:** the site tag;
  - **the editor's previews:** usable images only;
  - **the featured image:** saved, published, drawn, tagged, trashed, restored, removed; refused as a PDF, another site's or organization's, trashed; a page has none;
  - **logo and favicon:** variants, URLs, tags, audit, trashed, restored, removed;
  - **logo and favicon refusals:** PDF, pending, trashed, another site's or organization's, pre-M6-4, not an id;
  - **who may:** Editor refused, through the form too, Admin allowed;
  - **the composite keys** by constraint name.
- **Integration suites changed for the new variants and event shape:**
  - `media-processing`: real logo and favicon bytes, PNG content type, still frames, counted in storage;
  - `media-delivery`: PNG served as such;
  - `media-library`; `renderer`.
- **`isolation.test.ts`:** the logo/favicon form with B's slug, site and media (217 checks).
- **Unit:**
  - **planning and processing:** `processing.test.ts`;
  - **rendering:** the renderer and the XSS corpus (`figure`/`img` with hostile alt text, captions, links, size, `src`), `public-page.test.tsx` (blocks, missing images, featured image in both themes), `themes.test.tsx` (the logo in both headers);
  - **the editor:** the panel (fields from the schema; a real editor with the image block), the registry, the editor nodes;
  - **events and wording:** audit wording, cache events.
- **`tests/e2e/media-images.spec.ts`** (5):
  - **slash menu → picker,** uploading in it (PDF refused) → panel → saved → reload (no thumbnail loaded until asked; nothing saved by clicking around) → published → live `srcset` from `/media`, the variants served immutable, the original 404 → trashed (gone at once, its URL 404) → restored;
  - **a post's featured image** in Studio and Journal, then removed;
  - **logo and favicon:** the header, `<link rel="icon">` (a real 32 px PNG), removed;
  - **a PDF in Chromium;**
  - **a phone:** keyboard in the picker, the narrow variant chosen, no sideways scrolling.
  Repeated 5 times: 25 of 25 passed.
- `tests/e2e/editor.spec.ts`: a page with an image the library lacks opens, says so, and keeps the block. `content-admin.spec.ts`: the post sidebar's slot is the real one now.

## Addendum (M8-4, 2026-10-20): social images

ADR 0031 has the details.
- **An entry's social image and the site's default** are chosen with `MediaPicker`, checked with `usableImageIds` when they are new to what is saved, and resolved with `publicImages` when a page is drawn.
- **Each is the image's widest `w{n}` variant,** never the original. An unusable one falls back (entry → featured image → site default → none).
- **Tagged:** each is tagged `media:{id}` in the read that names it.
- **The trash's warning** (`usageOf`) counts them: a page or post whose social image it is, published or in a draft, and the site's default.
