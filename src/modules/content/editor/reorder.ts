import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/**
 * Reordering top-level blocks (M5-5; plan §6.3; decided 2026-10-01):
 *
 *  - Alt+↑ / Alt+↓ move the block holding the caret (or the selected block).
 *    **Each move is its own undo step**, closed on both sides: ProseMirror would
 *    otherwise group moves, and typing that follows one, less than half a
 *    second apart into one step (ADR 0003 discovery 11), and an undo would then
 *    put back a number of moves that depends on typing speed.
 *  - The block menu (on the drag handle, and on the toolbar for the keyboard)
 *    moves, duplicates and deletes the block it is opened for.
 *  - Dragging a block by its handle snaps to the gaps between top-level blocks,
 *    with a visible insertion gap. A drop inside a container (a column, a quote,
 *    a list) keeps ProseMirror's own behaviour.
 *
 * A moved block keeps its id; a duplicate is given new ones (UniqueID fills
 * ids left empty).
 */

/** Where the top-level block number `index` starts. */
function startOf(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

const ownStepKey = new PluginKey("blockOwnUndoStep");

/** Makes a transaction one undo step of its own: not merged with what came before (`closeHistory`), nor with what follows (see BlockMove). */
function ownUndoStep(tr: Transaction): Transaction {
  return closeHistory(tr).setMeta(ownStepKey, true);
}

/** The index of the top-level block at a document position. */
export const topLevelIndexAt = (doc: PMNode, pos: number): number => doc.resolve(Math.min(Math.max(pos, 0), doc.content.size)).index(0);

/** Swaps the top-level block `index` with its neighbour above (-1) or below (1); one undo step of its own. */
export function moveTopLevel(state: EditorState, index: number, direction: -1 | 1, keepSelection: boolean): Transaction | null {
  const { doc, selection } = state;
  const target = index + direction;
  if (index < 0 || index >= doc.childCount || target < 0 || target >= doc.childCount) return null;
  const start = startOf(doc, Math.min(index, target));
  const [first, second] = direction === -1 ? [doc.child(index), doc.child(target)] : [doc.child(target), doc.child(index)];
  const tr = state.tr.replaceWith(start, start + first.nodeSize + second.nodeSize, [first, second]);
  const delta = direction === -1 ? -doc.child(target).nodeSize : doc.child(target).nodeSize;
  if (keepSelection) {
    tr.setSelection(
      selection instanceof NodeSelection
        ? NodeSelection.create(tr.doc, selection.from + delta)
        : TextSelection.create(tr.doc, selection.anchor + delta, selection.head + delta),
    );
  } else {
    const moved = startOf(tr.doc, target);
    tr.setSelection(tr.doc.child(target).isAtom ? NodeSelection.create(tr.doc, moved) : TextSelection.near(tr.doc.resolve(moved + 1)));
  }
  return ownUndoStep(tr.scrollIntoView());
}

/** The block as JSON with every id removed, so the copy gets new ones. */
function withoutIds(node: JSONContent): JSONContent {
  const copy: JSONContent = { ...node };
  if (copy.attrs && "id" in copy.attrs) copy.attrs = { ...copy.attrs, id: null };
  if (copy.content) copy.content = copy.content.map(withoutIds);
  return copy;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockMove: {
      moveBlockUp: () => ReturnType;
      moveBlockDown: () => ReturnType;
    };
  }
}

/** The top-level block the selection is in, or null when it spans several. A selected top-level block (an atom) counts as in it. */
function selectedIndex(state: EditorState): number | null {
  const { selection } = state;
  const index = selection.$from.index(0);
  if (selection instanceof NodeSelection && selection.$from.depth === 0) return index;
  return selection.$to.index(0) === index ? index : null;
}

/** A Tiptap command: `state.tr` is the command's own transaction, which Tiptap dispatches. */
const moveCommand =
  (direction: -1 | 1) =>
  ({ state }: { state: EditorState }) => {
    const index = selectedIndex(state);
    return index !== null && moveTopLevel(state, index, direction, true) !== null;
  };

export const BlockMove = Extension.create({
  name: "blockMove",
  addCommands: () => ({ moveBlockUp: () => moveCommand(-1), moveBlockDown: () => moveCommand(1) }),
  addKeyboardShortcuts() {
    return { "Alt-ArrowUp": () => this.editor.commands.moveBlockUp(), "Alt-ArrowDown": () => this.editor.commands.moveBlockDown() };
  },
  // Closes the undo step after a move, a duplicate, a delete or a drop, so the typing that follows is a step of its own.
  addProseMirrorPlugins: () => [
    new Plugin({
      key: ownStepKey,
      appendTransaction: (transactions, _old, state) => (transactions.some((tr) => tr.getMeta(ownStepKey)) ? closeHistory(state.tr) : null),
    }),
  ],
});

// ── The block menu's actions, on the top-level block number `index` ───────────

export type BlockAction = "up" | "down" | "duplicate" | "delete";

export function runBlockAction(editor: Editor, index: number, action: BlockAction): boolean {
  const { state } = editor;
  if (index < 0 || index >= state.doc.childCount) return false;
  if (action === "up" || action === "down") {
    const tr = moveTopLevel(state, index, action === "up" ? -1 : 1, false);
    if (tr) editor.view.dispatch(tr);
    return Boolean(tr);
  }
  const start = startOf(state.doc, index);
  const node = state.doc.child(index);
  if (action === "duplicate") {
    const copy = state.schema.nodeFromJSON(withoutIds(node.toJSON() as JSONContent));
    editor.view.dispatch(ownUndoStep(state.tr.insert(start + node.nodeSize, copy).scrollIntoView()));
    return true;
  }
  // Delete: the document always keeps something to type in.
  const tr = state.tr.delete(start, start + node.nodeSize);
  if (tr.doc.childCount === 0) tr.insert(0, state.schema.nodes.paragraph!.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(start, tr.doc.content.size))));
  editor.view.dispatch(ownUndoStep(tr.scrollIntoView()));
  return true;
}

// ── Dragging: snap to the gaps between top-level blocks ───────────────────────

const snapKey = new PluginKey<number | null>("snapDrop");

/**
 * The top-level blocks being dragged by their handle: Tiptap's drag handle
 * selects them (a range of whole top-level blocks) and hands ProseMirror their
 * slice. Null for anything else (text dragged from inside a block, a drag
 * from outside the editor), and when the selection is no longer exactly what
 * is being dragged: then the drop is ProseMirror's own.
 */
function draggedBlocks(view: EditorView): { from: number; to: number } | null {
  const { dragging } = view;
  const { selection, doc } = view.state;
  if (!dragging?.move || selection.empty || selection.$from.depth !== 0 || selection.$to.depth !== 0) return null;
  if (!doc.slice(selection.from, selection.to).content.eq(dragging.slice.content)) return null;
  return { from: selection.from, to: selection.to };
}

/** The gap (0 = before the first top-level block, n = after the last) nearest the pointer, or null to leave the drop to ProseMirror. */
export function snapGap(view: EditorView, event: { clientY: number; target: EventTarget | null }): number | null {
  const target = event.target instanceof Element ? event.target : null;
  // Over a container's content: ProseMirror's own drop (into the column, quote or list).
  if (target?.closest('[data-forge-node="column"], blockquote, li') && view.dom.contains(target)) return null;
  const blocks = [...view.dom.children].filter((child) => !child.classList.contains("forge-drop-gap"));
  if (blocks.length === 0) return null;
  for (let index = 0; index < blocks.length; index++) {
    const box = blocks[index]!.getBoundingClientRect();
    if (event.clientY < box.top + box.height / 2) return index;
  }
  return blocks.length;
}

export const SnapDrop = Extension.create({
  name: "snapDrop",
  addProseMirrorPlugins: () => [
    new Plugin<number | null>({
      key: snapKey,
      state: {
        init: () => null,
        apply: (tr, value) => {
          const next = tr.getMeta(snapKey) as number | null | undefined;
          return next === undefined ? value : next;
        },
      },
      props: {
        decorations(state) {
          const gap = snapKey.getState(state);
          if (gap === null || gap === undefined || gap > state.doc.childCount) return null;
          const marker = document.createElement("div");
          marker.className = "forge-drop-gap";
          marker.setAttribute("data-testid", "drop-gap");
          return DecorationSet.create(state.doc, [Decoration.widget(startOf(state.doc, gap), marker, { side: -1, key: `gap-${gap}` })]);
        },
        handleDOMEvents: {
          dragover(view, event) {
            const gap = draggedBlocks(view) ? snapGap(view, event) : null;
            view.dom.toggleAttribute("data-snapping", gap !== null);
            if (gap !== snapKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(snapKey, gap));
            return false;
          },
          dragleave(view, event) {
            if (event.relatedTarget instanceof Node && view.dom.contains(event.relatedTarget)) return false;
            view.dom.removeAttribute("data-snapping");
            if (snapKey.getState(view.state) !== null) view.dispatch(view.state.tr.setMeta(snapKey, null));
            return false;
          },
          dragend(view) {
            view.dom.removeAttribute("data-snapping");
            if (snapKey.getState(view.state) !== null) view.dispatch(view.state.tr.setMeta(snapKey, null));
            return false;
          },
        },
        handleDrop(view, event, _slice, moved) {
          const range = moved ? draggedBlocks(view) : null;
          const gap = range ? snapGap(view, event) : null;
          view.dom.removeAttribute("data-snapping");
          if (!range || gap === null) {
            if (snapKey.getState(view.state) !== null) view.dispatch(view.state.tr.setMeta(snapKey, null));
            return false;
          }
          const { from, to } = range;
          const at = startOf(view.state.doc, gap);
          const tr = view.state.tr.setMeta(snapKey, null);
          // Dropped where it already is (the gap just above or below it): nothing moves.
          if (at < from || at > to) {
            const blocks = view.state.doc.slice(from, to).content;
            tr.delete(from, to);
            const insertAt = tr.mapping.map(at, -1);
            tr.insert(insertAt, blocks);
            tr.setSelection(blocks.childCount === 1 ? NodeSelection.create(tr.doc, insertAt) : TextSelection.between(tr.doc.resolve(insertAt), tr.doc.resolve(insertAt + blocks.size)));
            view.dispatch(ownUndoStep(tr.scrollIntoView()));
          } else {
            view.dispatch(tr);
          }
          event.preventDefault();
          return true;
        },
      },
    }),
  ],
});
