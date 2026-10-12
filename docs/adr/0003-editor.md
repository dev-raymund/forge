# ADR 0003: One Tiptap document per entry, closed schema, closed renderer

| | |
|---|---|
| **Status** | Accepted for V1. Proven locally: headless tests and real Chromium |
| **Date** | 2026-09-30 |
| **Spike** | S3 / M0-5 (v1-github-issues.md) |
| **Decisions touched** | D-14 as refined in v1-build-plan §6, and D-38 (clarified, not changed) |

## Question

Can the V1 editor from plan §6 be built on open-source Tiptap: one ProseMirror document per entry, 11 block types, custom nodes with React NodeViews, stable ids, top-level drag and keyboard reorder, and a closed server renderer? And do the storage contract, validation, autosave and conflict handling hold up?

## What was built (`spikes/editor/`)

| File | Role | Moves to (M5) |
|---|---|---|
| `schema.ts` | Zod contract for `{ v, doc }`: per-node attrs, marks, link and embed allow-lists, limits | `src/blocks/*/schema.ts` + a document schema in `modules/content` |
| `extensions.ts` | The closed Tiptap schema, shared by browser and server: custom nodes, extended native nodes, UniqueID, `BlockMove` (Alt+↑/↓), `PasteGuard`, columns normalizer | `src/blocks/*/extension.ts` |
| `document.ts` | Load/save pipeline: size and node limits, per-node `v` migration, validation, duplicate-id check, trailing-paragraph trim (isomorphic) | `modules/content` |
| `render.tsx` | Closed node → React renderer; re-validates every node; unknown or invalid nodes are skipped and reported | `src/themes/_kit/blocks/*` (M5-6) |
| `node-views.tsx` | React NodeViews for image, button and columns | `src/blocks/*/editor.tsx` |
| `autosave.ts` | Client autosave controller: 2 s debounce, 30 s max wait, one save in flight, local buffer per entry + version, stop on conflict | `modules/content/editor` |
| `save-draft.ts` | Server `saveDraft(ctx, entryId, expectedVersion, content)`: validate, then one conditional `UPDATE … WHERE version = $expected` inside `withTenant` | `modules/content` (M5-3) |
| `editor.tsx`, `/dev/editor` | Manual test page with an in-memory save server; `notFound()` on Vercel production | deleted in M5 |

## Evidence

| Requirement | Test | Result |
|---|---|---|
| All 11 blocks: document JSON, serialization, deserialization | `editor.test.ts`: JSON → editor → JSON, and editor HTML → editor → JSON, both identical after normalization | ✔ |
| Validation: closed schema, limits (1 MB, 2,000 nodes), `v` migration | `document.test.ts` (19 tests) | ✔ |
| Columns 2–3, **nesting impossible** | Editor schema (`columns` is in group `layout`; column, quote and list item take `block`), Zod and renderer; `nodeFromJSON(nested).check()` throws; inserting columns inside a column lands outside it | ✔ |
| Stable UUIDv7 ids; they survive edits; copy/paste re-ids the copies and keeps the originals | `editor.test.ts` (real paste events) + `editor-spike.spec.ts` (Chromium, ProseMirror's own copy serializer and paste parser) | ✔ |
| Reorder by drag handle and Alt+↑/↓; undo across reorder | `editor.test.ts` (keyboard, undo/redo, moving a columns block keeps every id) + `editor-spike.spec.ts` (real drag and drop through Tiptap's drag handle; real keys; Cmd/Ctrl+Z) | ✔ |
| Renderer emits only allow-listed elements; pasted `<script>`/`onerror` dropped | `render.test.tsx`: 31-payload XSS corpus fed straight to the renderer. `editor.test.ts` + E2E: hostile paste in happy-dom and in Chromium, with `window.__xss` still 0 | ✔ |
| Autosave approach | `autosave.test.ts` (fake timers, 10 tests): debounce, forced save, no overlapping saves, error retry, buffer kept on conflict, storage failures tolerated | ✔ |
| Version / conflict handling | `save-draft.integration.test.ts` (Postgres through PgBouncer as `forge_app`): stale version → conflict with no write; two tabs from the same version → exactly one wins; invalid document rejected before the DB; another org's entry → not found (RLS). E2E: a save from "another tab" → conflict → reload → saves again | ✔ |

Commands: `npm test` (spike unit tests included), `npm run test:integration`, `npm run test:e2e`. The E2E spec passed 5 consecutive stress rounds (`--repeat-each=5`, 4 workers, 150 runs). One earlier round had 2 failures that I could not reproduce after the timing fixes.

## Decision

Build the V1 editor exactly as plan §6 describes, on Tiptap 3 (MIT, pinned 3.31.3). Nothing in the spike calls for a design change.

**Extensions (all open source, MIT; no Tiptap Pro or Cloud):**
- `@tiptap/core`, `@tiptap/react`, `@tiptap/pm`
- `@tiptap/starter-kit`, without `codeBlock` and `hardBreak` (not in the V1 block set); `document`, `blockquote` and `horizontalRule` are replaced by extended versions
- `@tiptap/extension-document`, `-blockquote`, `-horizontal-rule` (extended with our content rule and attributes)
- `@tiptap/extension-unique-id`
- `@tiptap/extension-drag-handle-react` + `@tiptap/extension-drag-handle`, whose peers are `@tiptap/extension-collaboration`, `@tiptap/extension-node-range`, `@tiptap/y-tiptap`, `yjs` and `y-protocols` (see gap 7)
- Tests only: `happy-dom`

## Discoveries and known gaps (for M5; no scope change)

1. **Pasted custom-node attributes are untrusted.** Any web page can carry `data-forge-node="button" data-href="javascript:…"`. `PasteGuard` drops custom nodes whose attrs fail their Zod schema at paste time (verified by mutation: removing it fails the test). Save and render validate again. NodeViews show hrefs as text, never as live links.
2. **`columns.count` and `ratio` restate the number of children.** Pasting a partial selection produced a `columns` node whose `count` disagreed with its children. The document then failed validation and autosave stalled on "invalid" (found in Chromium). A normalizing plugin now keeps `count` and `ratio` in sync after every transaction.
3. **Where ids come from.** UniqueID assigns ids on Tiptap's *asynchronous* `create` event and in `appendTransaction`. It strips ids from pasted content only on a real `paste` DOM event. So:
   - Cut and paste gives the moved blocks new ids; keyboard and drag moves keep them.
   - Programmatic inserts can duplicate ids. `parseDocument` rejects duplicates. M5-4 should dedupe on the client before saving so a bug can't stall autosave, and M10 must assign ids to API-written nodes.
4. **Drop position follows ProseMirror, not the visual half.** Dropping on a textblock goes before or after it depending on the *document* position under the cursor. Dropping on a quote, list or column goes *inside* it: that is valid content, and useful for columns. M5-5 should add a `handleDrop` that snaps top-level drags to the nearest top-level gap by vertical position, unless designers prefer the default.
   **Resolved 2026-10-01:** snap to the gaps between top-level blocks, with a visible insertion gap. Drops into containers keep ProseMirror's normal behaviour (plan §6.3). Built in M5-5 (`SnapDrop`, see the addendum).
5. **Cache Components: the editor must be client-only.** Tiptap generates random ids during render, and prerendering rejects `Math.random()` in a client component. `next/dynamic(…, { ssr: false })` fixes this and also lazy-loads the editor, which plan §18 wants anyway.
6. **Normalization on save.** Tiptap's link attributes (`target`, `rel`, `class`, `title`) are stripped, so only `href` is stored. The trailing empty paragraph (TrailingNode) is trimmed, and the editor re-adds it on load. Stored documents stay byte-stable across a load/save round trip.
7. **Bundle.** The editor chunk is 225 KB gzip; Tiptap's drag handle adds about 50 KB because it imports Yjs and the collaboration packages at module level. It is admin-only and lazy-loaded, so this is accepted for V1. If editor load time becomes a problem, a custom handle (about 100 lines) removes the 50 KB. Zod is also in the client bundle (paste guard, pre-save validation); `zod/mini` is an option.
8. **Pasted h1, h5 and h6 become paragraphs** (only levels 2–4 exist). M5-4 can map h1 → h2 and h5/h6 → h4 with `parseHTML` rules. Shift+Enter line breaks are not in the block set; revisit if editors ask.
9. **Embed "allow-listed form providers" are undefined in the plan.** The spike allows YouTube (`youtube-nocookie.com`) and Vimeo (`dnt=1`) in a sandboxed iframe. M5-5 needs the concrete provider list before adding any.
   **Resolved 2026-10-01:** YouTube, Vimeo, and a `generic` https iframe URL accepted only after URL-safety validation. No provider-specific integrations (plan §6.1).
10. **Test environment quirks.** happy-dom must not load resources from parsed HTML (it tried to fetch pasted iframe URLs), so the unit project disables that. Its `CSSStyleSheet` lacks the legacy `rules` alias that ProseMirror reads when pasted HTML contains `<style>`, so the test shims it.
11. **Block moves made within half a second are one undo step** (found 2026-10-07, during M3-5's verification). `BlockMove` dispatches each move as one transaction, and ProseMirror's history then groups changes that are less than 500 ms apart and touch the same range. Three quick Alt+↑/↓ presses and one Cmd/Ctrl+Z undo all three; a pause after the first, and the same undo reverts only the last two. The browser test undid after three moves and so passed or failed by timing (it failed once on a loaded machine); it now undoes after a single move. Nothing in the spike's code changed. M5-5 decides whether each move should be its own undo step (`closeHistory(tr)` in the command) and tests that.
   **Resolved in M5-5:** each move is its own undo step (see the addendum).

## Estimate for Phase 5

The spike covers the risky parts of M5-4, M5-5 and M5-6: schema, the pipeline, the renderer, ids, reorder, paste safety, and the autosave and conflict mechanics. What remains is mostly product UI:
- The slash menu and "+" inserter.
- The properties panel generated from the Zod schemas.
- The block menu (move, duplicate, delete).
- The link and entry picker.
- The conflict dialog.
- The title field and the entry sidebar.
- Theme styles for the rendered blocks, and gaps 3, 4 and 8 above.

Editor work (M5-4 + M5-5) is estimated at **about 2 engineer-weeks**. That fits inside the plan's 3.5 weeks for Phase 5, so the plan does not change.

---

## Addendum (M5-4, 2026-10-12): the editor shell, text nodes only

What was built, from the spike, and the decisions it took:

- **Where it lives.**
  - The text nodes: `src/blocks/text-nodes/extensions.ts` (StarterKit without code blocks and line breaks; headings 2–4; quote with `cite`; divider with `style`; links limited to `isSafeHref`; UniqueID with UUIDv7 on every top-level node).
  - The editor: `src/modules/content/editor/` (autosave, slash menu, link dialog, the screen).
  - The routes: `/…/pages/[entryId]` and `/…/posts/[entryId]`, via `EntryEditorPage`.
  - The spike's custom nodes, drag handle and `/dev/editor` page stay until M5-5 moves them into the block registry.
- **Client-only and lazy** (gap 5): `next/dynamic(…, { ssr: false })`. The admin's other pages do not load Tiptap.
- **A document with blocks this editor lacks** (image, button, columns, embed, spacer: M5-5 and M6) is not loaded into it. Loading it would drop those blocks on the next save. The page says so, and nothing is saved.
- **Saving.**
  - Autosave calls the M5-3 action `saveDraftAction` with `version` and `{ title, content }`. Before sending, the editor dedupes ids (gap 3) and runs `parseDocument`; the server checks again.
  - A save is shown as saved only when the server answers with the new version. A conflict, refused content, or a failed request is shown as not saved; a failed request is retried.
  - A successful save does not re-render the page (`FormOutcome.refresh: false`): autosave runs every few seconds, and the editor holds the draft.
- **Conflicts.**
  - The dialog offers **Load the latest version** (this tab's unsaved changes are given up) and **Copy my changes** (to the clipboard).
  - Plan §6.3's third choice, overwrite after keeping the other version as a revision, needs M7-3's `save` revisions and is left to it.
  - While in conflict the editor is read-only: what is typed could not be saved.
- **The local buffer** (per entry + draft version, `localStorage`) restores changes from a tab closed or crashed before its save. Only the same version is restored, so another tab's newer save is never overwritten by an old buffer.
- **The slash menu** works in top-level paragraphs: `/` and a few letters. It offers Text, Heading 2–4, the two lists, Quote and Divider, and is keyboard-driven (↑/↓, Enter, Esc).
- **Paste.** Only the text nodes and marks exist, so anything else pasted is dropped. `h1` becomes `h2`, and `h5`/`h6` become `h4` (gap 8). Unsafe links are not kept.
- **Links** are typed addresses or the site's pages and posts, found by title through `GET /api/app/entries/search?org&site&q`. That route needs a session and membership, searches the named site only, and treats `%` and `_` as literal text. Entries are stored as `entry:{id}`.
- **Publish** saves any pending change first, then calls `publishEntryAction` with the version just saved. "Already published" and conflicts are told as such.
- **Who may.** The page opens for every member: reading is every role's. The services' policies decide `canEdit` and `canPublish`; the screen shows read-only when they are false, and the services refuse anyway.
- **Reaching it.** The site overview has a Home page card linking to its editor. A site made before M5-3 has no Home page, and the card says so. Creating pages and making one the home page from the admin is M5-7's.

## Addendum (M5-5, 2026-10-12): the block registry, the properties panel, reordering

What was built, and the decisions it took:

- **The block registry** (`src/blocks/`). Each block has a folder with:
  - `schema.ts`: its attributes as Zod, with panel hints in `.meta()`, its `v`, its `migrate` table, the defaults of a new block, and whether the editor edits it;
  - `extension.ts`: the Tiptap node;
  - `node-view.tsx`: the React NodeView;
  - `render.tsx`: the renderer.

  Three files assemble them: `schemas.ts` (pure; the document's validation is built from it), `editor.ts` (nodes, NodeViews, slash-menu inserts; client) and `render.tsx` (`BLOCK_RENDERERS`). A test keeps the three in step. There is one definition of each block: `modules/content/document/schema.ts` now takes the attributes from the registry (`attrs = NODE_ATTRS`), and `parse.ts` takes the migrations (`NODE_MIGRATIONS`).
- **The blocks.**
  - `button`: text up to 80 characters; a link limited to `isSafeHref`; style; alignment; new tab.
  - `columns` / `column`: 2 or 3 columns; the widths must fit the number of columns.
  - `embed`: YouTube, Vimeo, or a generic page; four shapes.
  - `spacer`: four heights.
  - `image`: schema only (`editable: false`). Its editor, NodeView, renderer and picker are M6-4's. A document with an image is still not opened for editing.
- **The editor's schema** is `editorExtensions()` in `modules/content/editor/extensions.ts`: the text nodes, a document of `(block | layout)+`, the registry's nodes, `PasteGuard`, `BlockMove`, `SnapDrop` and UniqueID. `EDITOR_NODE_TYPES` replaces `TEXT_NODE_TYPES` in the check for blocks this editor lacks.
- **Validation stays the server's.** `parseDocument`'s pipeline is unchanged; the new blocks' rules come from their schemas. Unknown nodes are refused. Unknown attributes are dropped, as before (gap 6).
- **URL safety** (`platform/net/url-safety.ts`) is what a generic embed must pass. The address must:
  - be `https`;
  - have no user name, password or port;
  - name a host, not an IP address;
  - have a top-level domain of letters;
  - not end in a private or documentation name (`localhost`, `.local`, `.internal`, `.test`, `.example`, …);
  - be at most 2,048 characters;
  - not be one of the blocked hosts or below one. On save and publish the server blocks the app's own host (`APP_ORIGIN`), so a site cannot frame Forge. The renderer takes `blockedHosts` from its context.
- **Embeds.**
  - The provider follows the address (`providerOf`), so a YouTube or Vimeo address always plays through the privacy players.
  - The stored `url` is what the person gave. The frame's source is always made from it (`embedSrc`), never taken as it is.
  - An embed is inserted only from a dialog, once its address is valid, so the document is never left unsavable.
  - The admin shows the address as text and loads nothing third-party.
  - The renderer's frame is lazy and sandboxed, with a strict referrer policy. Only YouTube and Vimeo get the media `allow` list.
- **References are checked on the server** (`modules/content/references.ts`), against the ids the browser sent:
  - **Saving.** Every image (`mediaId`) and every `entry:` link (in text, a button or an image) that is *new* in the save must belong to this site. A media item must also be ready and not deleted; an entry must not be in the trash. References already in the draft are not checked again, so trashing a linked page never makes an unrelated edit unsavable.
  - **Publishing.** Nothing may point at another site of the organization. Another organization's rows are invisible anyway (RLS).
- **The properties panel** (`editor/panel/`) is generated from the block's schema by `fieldsOf`: text fields, choices and switches, labelled by the `.meta()` hints. Keys marked `hidden` are not fields: the id, `v`, a columns block's `count` and an embed's `provider`.
  - A change is applied only when the whole block is valid. Otherwise the field keeps what was typed and shows why, and the block keeps its last valid attributes: nothing is half-applied or dropped.
  - Everything else is read from the document, so an undo shows at once.
  - Columns: "Add a column", and "Remove the last column" only when that column is empty. The widths offered fit the number of columns.
  - A link field has the same page picker as the link dialog.
  - On a wide screen the panel sits beside the text. On a phone it is a sheet kept at the bottom of the screen.
- **Reordering.**
  - **Keyboard.** Alt+↑/↓ moves the block holding the caret, or the selected block. **Each move is its own undo step** (discovery 11, decided here), closed on both sides: `closeHistory` on the move, and a closing transaction after it, so typing straight after a move is a step of its own. Tested with moves quicker and slower than the 500 ms grouping delay.
  - **Block menu.** Move up, Move down, Duplicate (the copy gets new ids) and Delete (the document keeps a paragraph to type in). It is on the drag handle, and on the toolbar ("Block actions") for keyboard users.
  - **Dragging** snaps to the gaps between top-level blocks, with a visible insertion gap (gap 4). A drop over a column, a quote or a list item keeps ProseMirror's behaviour. The snap applies only while the selection is exactly the blocks being dragged (Tiptap's handle selects them as a node range); otherwise the drop is ProseMirror's own.
- **The slash menu** also works in a column's paragraph, and there it does not offer columns.
- **Paste.** `PasteGuard` checks every pasted custom block against its registry schema. A pasted part of a columns block keeps its columns, and its `count` and `ratio` are re-synced (gap 2).
- **Autosave saves edits only.** A transaction that leaves the stored draft as it is no longer saves a new version. Examples: the empty paragraph Tiptap adds after a final block on the first click, or ids and the trailing paragraph added while the editor is created. Before this, merely opening a page that ended in a block (or a heading) and clicking made a new version, and another open tab's next save became a conflict. The comparison is with what was last handed to autosave, not with what was last saved, so undoing an edit while it is being saved is still saved.
- **The spike is retired.** Deleted: `spikes/editor/`, `/dev/editor`, `tests/e2e/editor-spike.spec.ts` and the `@spikes` path alias. Its editor tests were ported to `modules/content/editor/blocks.test.ts`. Its whole-document renderer and 31-payload XSS corpus belong to M5-6 and are in git history (`spikes/editor/render.tsx`, `render.test.tsx` at `e55a37d`).
