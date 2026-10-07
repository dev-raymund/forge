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
   **Resolved 2026-10-01:** snap to the gaps between top-level blocks, with a visible insertion gap. Drops into containers keep ProseMirror's normal behaviour (plan §6.3).
5. **Cache Components: the editor must be client-only.** Tiptap generates random ids during render, and prerendering rejects `Math.random()` in a client component. `next/dynamic(…, { ssr: false })` fixes this and also lazy-loads the editor, which plan §18 wants anyway.
6. **Normalization on save.** Tiptap's link attributes (`target`, `rel`, `class`, `title`) are stripped, so only `href` is stored. The trailing empty paragraph (TrailingNode) is trimmed, and the editor re-adds it on load. Stored documents stay byte-stable across a load/save round trip.
7. **Bundle.** The editor chunk is 225 KB gzip; Tiptap's drag handle adds about 50 KB because it imports Yjs and the collaboration packages at module level. It is admin-only and lazy-loaded, so this is accepted for V1. If editor load time becomes a problem, a custom handle (about 100 lines) removes the 50 KB. Zod is also in the client bundle (paste guard, pre-save validation); `zod/mini` is an option.
8. **Pasted h1, h5 and h6 become paragraphs** (only levels 2–4 exist). M5-4 can map h1 → h2 and h5/h6 → h4 with `parseHTML` rules. Shift+Enter line breaks are not in the block set; revisit if editors ask.
9. **Embed "allow-listed form providers" are undefined in the plan.** The spike allows YouTube (`youtube-nocookie.com`) and Vimeo (`dnt=1`) in a sandboxed iframe. M5-5 needs the concrete provider list before adding any.
   **Resolved 2026-10-01:** YouTube, Vimeo, and a `generic` https iframe URL accepted only after URL-safety validation. No provider-specific integrations (plan §6.1).
10. **Test environment quirks.** happy-dom must not load resources from parsed HTML (it tried to fetch pasted iframe URLs), so the unit project disables that. Its `CSSStyleSheet` lacks the legacy `rules` alias that ProseMirror reads when pasted HTML contains `<style>`, so the test shims it.
11. **Block moves made within half a second are one undo step** (found 2026-10-07, during M3-5's verification). `BlockMove` dispatches each move as one transaction, and ProseMirror's history then groups changes that are less than 500 ms apart and touch the same range. Three quick Alt+↑/↓ presses and one Cmd/Ctrl+Z undo all three; a pause after the first, and the same undo reverts only the last two. The browser test undid after three moves and so passed or failed by timing (it failed once on a loaded machine); it now undoes after a single move. Nothing in the spike's code changed. M5-5 decides whether each move should be its own undo step (`closeHistory(tr)` in the command) and tests that.

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
