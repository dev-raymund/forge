# ADR 0027: Previews of the draft and of revisions

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-16 |
| **Issue** | M7-4 (v1-github-issues.md), with revision preview added by the M7-4 brief |
| **Decisions touched** | Plan §9 (Preview); builds on ADR 0006 (`/_forge/preview/{token}` on the one V1 host; site pages never receive the admin's credentials), ADR 0013 (Coming soon), ADR 0017 (the closed renderer and the theme's templates), ADR 0023 (usable images), ADR 0026 (revisions) |

## Context

**M7-4's criteria:**
- **`createPreviewToken(entryId)`:** HMAC (`PREVIEW_TOKEN_SECRET`), 15 min, bound to the site, the entry and the user.
- **`/_forge/preview/{token}`:**
  - rewritten by the proxy into the site renderer; the token alone identifies the site and the entry;
  - renders the draft via **uncached** queries;
  - sends `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`, with `frame-ancestors 'self'`.
- **The editor:** a preview pane (iframe) and "open in new tab"; autosave flushed before the preview; works for coming-soon sites.
- **Testing:** a tampered or expired token is a 404; the response headers are asserted; E2E shows unpublished changes.

**ADR 0017's hand-off:** a preview uses the same pieces as the public page, `renderDocument` and the theme's template through `PublicPageView`'s choices, never the cached public reads. It bypasses Coming soon and carries `noindex`.

**The M7-4 brief added revision preview:** in the history, look at a revision as it was saved before restoring it. Preview and restore stay separate operations, and looking changes nothing. The issue file named only draft preview. Both were built, after asking, through one mechanism.

## Decision

### 1. One link for both: a signed token (`platform/routing/preview-token.ts`)

**What a token is:** `base64url(payload).base64url(HMAC-SHA256)`.
- **The payload:** `{ v: 1, o: organization, s: site, e: entry, u: user, r?: revision, x: expiry }`.
- **The signature** is over `forge-preview:v1:{payload}`, checked in constant time.
- **15 minutes.** Nothing else is accepted: another version, a malformed id, a non-integer expiry, extra segments.

**The secret:** `PREVIEW_TOKEN_SECRET`, at least 32 characters.
- **On localhost only** (never on Vercel), a fixed development secret, as auth's.
- **Elsewhere without it,** previews are off and say so ("Previews are not set up on this server yet"). The proxy answers 404.
- **Empty variables count as unset** (`NAME=` in `.env` files).

**Who gets one** (`content/preview.service.ts`, `createPreviewLink`; action `previewLinkAction`):
- Whoever may see the entry, plan §9's "read": the same rule as the editor and the history.
- An Author gets no link to a page or another Author's post: not found, as an entry of another site. A Viewer gets links.
- A revision is looked up in that entry.
- Nothing is written, recorded or flushed.

### 2. The route

- **The proxy** (`decideRoute`: `{ kind: "preview" }`):
  - checks the token's shape, then its signature and expiry, before anything renders. Anything else is a plain 404;
  - removes the cookie and `Authorization` as for site pages (ADR 0006);
  - rewrites to the internal `/render/preview/{token}`. Direct `/render/*` stays a 404;
  - sends the site's framing headers (`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`) and `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`. The address holds the token, so it is never sent on.
- **Next.js in production** sends its own no-store `Cache-Control` for the request-time page; it keeps `private` and `no-store` (asserted in E2E).
- **Only on the app host.** In host mode (post-V1) a tenant's host never reaches it.
- **The page** (`app/(sites)/render/preview/[token]`, root layout #3, under the `(sites)` lint rules: no auth, no session):
  - It is its own route, not `render/[site]`. That route's unknown params get Cache Components' app shell and are kept for the next visitor (ISR); a preview must never be.
  - Everything private is read inside `<Suspense>` after `connection()`: never prerendered, never cached. The build marks it ◐ (an empty static shell).
  - Metadata: `noindex, nofollow`, no referrer, the title "Preview".

### 3. What a preview shows (`rendering/preview.ts`, `loadPreview`): checked again, read fresh, drawn by the same renderer

On every request:
1. **The token** is checked again.
2. **The person** it names must be a member now, whose role may see the entry now. This is `content/shared`'s `roleMaySeeEntry`, the catalog's rule asked of a role (tested against `canSeeEntry` for every role, on real contexts). A member removed or demoted since gets nothing.
3. **The entry** is not in the trash and belongs to that site; the site is not deleted or suspended. Coming soon does not stop a preview, as ADR 0013 planned, and the banner says the site is not live.
4. **The draft, or that revision of that entry,** is read in the organization's tenant transaction, with the terms that are still the site's and the images that are usable images of the site (`publicImages`: variants only, never an original, never another site's).
5. **Public cached reads** are used only for what is public anyway: the site's settings (`loadPublicSite`) and where `entry:` links go on the live site (`livePaths`). A link to a page that is not live has no address. Another site's has none either.

Every refusal gets one answer: "This preview is not available". Nothing says why. Inside the streamed boundary that answer comes with a 200; a tampered or expired token never gets that far (the proxy's 404).

**Drawn** by `PublicPageView` inside the theme's `Layout`:
- the closed renderer, which checks every node against the block registry, never stored HTML and never `dangerouslySetInnerHTML`;
- embeds as on the public site (privacy-enhanced YouTube and Vimeo, sandboxed; never Forge's own host);
- buttons and images that point at nothing usable are drawn as nothing.

**The banner** (outside the theme, plain styles, so no theme hides it) says what this is:
- **Draft:** "Preview of the draft", and whether it is the published version, is waiting for publishing, or is not part of the schedule's frozen revision.
- **Revision:** "Preview of revision N · Saved · {label}", when it was saved, that viewing it does not restore or publish it, and whether visitors see it now ("Live"), whether the schedule publishes it (with the time), or neither.
- **On a Coming soon site:** that visitors see its Coming soon page.
- **What it cannot show:** "2 parts of it cannot be shown…" (unknown or invalid nodes, counted with the renderer's own `onSkip`), and "1 image is no longer in the media library".

The revision is never changed to make it render.

### 4. In the admin

- **"Preview" in the editor header** (`editor/preview-pane.tsx`): every member who can open the editor.
  - An editor's typing is saved first (autosave `flush`), so the pane shows what they see. A reader previews the draft as it is. Off during a conflict.
  - **The pane:** a large dialog with an iframe and "Open in a new tab".
- **The frame:**
  - `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`: no same origin, so the page cannot reach the admin; no forms, no top navigation. Scripts are Next's own, which reveal the streamed content; a site has no scripts of its own.
  - `referrerpolicy="no-referrer"`.
- **The history** (`editor/revision-history.tsx`):
  - Every revision has "Preview". It switches the dialog to that revision: its number, kind, label, who, when, and the Live or schedule markers, with a note that viewing it changes nothing and the draft is as it was left.
  - The preview frame, "Back to the history", and **"Restore this revision…"** for those who may edit. That is the separate, confirmed M7-3 restore (`restoreRevisionAction`), with its version check: a draft saved elsewhere since is refused there, and nothing changes.
- **The editor underneath is untouched:** what is typed, autosave (which goes on saving while the history is open), the local copy and the sidebar.

### 5. What never happens

Opening, reloading or closing a preview writes nothing:
- no draft, entry, status, published revision, date, schedule, frozen revision, parent, slug, path, terms, author or featured image;
- no revision;
- no audit event;
- no cache flush.

Its private reads are never cached. Tested by a digest of every content, history, record, media and job row of the organization before and after, and by the cache calls noted.

## Not in M7-4

- **Comparing revisions:** a SHOULD after V1.
- **Previews on the site's own host:** post-V1, ADR 0006.
- **A preview that outlives the person's session:** the link is a bearer link for 15 minutes. It names its person, who must still have access; whoever holds the address sees the page meanwhile, as plan §9 and ADR 0006 describe ("the token alone identifies site + entry"). It is shown only to that person, and never sent on as a referrer.

## Why, and what it costs

| Decision | Reason | Tradeoff | Reconsider when |
|---|---|---|---|
| The token, not the session, is the credential | Site pages never receive the admin's cookie (ADR 0006), and lint keeps auth out of the site tree | A copied link works for 15 minutes for whoever has it | Previews move to their own origin with a session |
| The person's rights checked again on every request | A demotion or removal ends their previews at once, not in 15 minutes | Two small queries per preview | — |
| One route for the draft and revisions | One renderer, one access model, one set of headers | Revision previews need a token too | — |
| Its own route, not `render/[site]` | That route's unknown params are cached for the next visitor (Cache Components' ISR) | A third root layout | Next offers a per-route "never cache" |
| The proxy checks the signature before rendering | A real 404 for tampered or expired tokens, before anything streams | The secret is read in the proxy | — |
| A frame without same origin | The preview can never act on the admin | Fonts from the app's origin may fall back inside the frame | — |
| The site's public settings and live paths from the public cache | They are public anyway, and the same reads the site uses | — | — |

## Evidence

- **`tests/integration/content-preview.test.ts`** (11, real Postgres through PgBouncer):
  - **The link:** what it names, 15 minutes, read-only (digest and cache unchanged).
  - **Who:** every role, an Author's own posts only, no pages; `roleMaySeeEntry` against `canSeeEntry` for every role; another site's entry or revision, a non-id, the trash; the action's answers; off without a secret away from localhost.
  - **The draft:** shown as saved now (title, text, image, featured image), not the published version; the public page unchanged; nothing written or flushed, no private read tagged; once published, "the published version"; a Coming soon site.
  - **References:** usable images only (not a trashed one, another site's, or an original); links to live pages of this site only.
  - **Revisions:** every kind with its metadata; Live; a schedule's frozen revision and its time (the draft's later edits not in it, the schedule unchanged); a legacy revision with unknown and invalid nodes, drawn in part, counted, and left as it is.
  - **The token again:** tampered, expired, another secret, B's entry or revision, another site, a sibling entry's revision; a demoted, then removed, member; a pruned revision; a trashed then deleted entry; a suspended site.
  - **Around edits:** a preview between saves, an overwrite and a restore. The draft, the history, the records and the public page are only what those did, and the same link shows the draft as it is when opened.
  - **Mutation checks:**
    - without the person's role being checked again, the demotion test fails;
    - without the revision being looked up in its entry, the sibling test fails.
- **`isolation.test.ts`:** `createPreviewLink` (the draft, and a revision) and `submitPreviewLink` with B's entry, from A's site and from B's URL.
- **Unit:**
  - the token (signing, expiry, tampering, forged fields, the secret);
  - the route decision (`/_forge/preview/{token}` only, one segment, no Server Actions, internal route refused, the app host only in host mode, credentials removed);
  - the role rule.
- **E2E `content-preview.spec.ts`** (2, production build; 10 of 10 over five repeats):
  - **The draft:** typed and previewed at once (saved first); the theme draws it on a Coming soon site; the headers asserted; a new tab; visitors still see Coming soon; a changed or expired link and the internal route are 404s; no revision added.
  - **A revision:** previewed from the history with unsaved typing in the editor, which is then saved; Back; the Live one; a restore from the preview refused after another tab saved, then done after a reload; a Viewer previews with nothing to restore.

## Addendum (M8-1, 2026-10-17): a second kind of token, for appearance previews

ADR 0028 has the details.

- **The appearance editor's live preview** uses this route with a second kind of token: `{ v: 1, k: "appearance", o, s, u, t: settings, x }`. It carries the unsaved kit-level settings and is signed under its own label, so neither kind is ever read as the other.
- **The proxy** accepts either. The page draws the site's home page with the token's settings, after checking them against the kit's schema and the person's `site.settings.manage` again.
- **`PREVIEW_TOKEN_SHAPE`** now allows a payload of up to about 4 KB.
- **Entry previews are unchanged.**

## Addendum (2026-10-17, found during M8-1's manual check): the frame on Next's development server

- **The problem:** Next's development server refuses its own scripts to a document with an opaque origin. This is its cross-origin protection for dev resources (`allowedDevOrigins`), which cannot name one. The preview frames' sandbox (no `allow-same-origin`) gives the preview exactly such an origin, so on `next dev` the streamed preview stayed hidden in the frame. "Open in a new tab" still worked.
- **Production builds were never affected:** the E2E suites check the content inside the frames.
- **The fix:** the sandbox is now one constant for every preview frame (`platform/routing/preview-frame.ts`, `PREVIEW_FRAME_SANDBOX`).
  - **Unchanged outside development:** scripts and popups only. A unit test pins it.
  - **In development only:** it adds `allow-same-origin`, so the frame works on the local server.
