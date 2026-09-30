import { Extension, Node, mergeAttributes, type AnyExtension, type CommandProps } from "@tiptap/core";
import Blockquote from "@tiptap/extension-blockquote";
import Document from "@tiptap/extension-document";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import UniqueID from "@tiptap/extension-unique-id";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { uuidv7 } from "uuidv7";
import { attrs as attrSchemas, isSafeHref } from "./schema";

/**
 * The closed Tiptap schema (plan §6.1), shared by the editor and the server.
 * No React here: the editor swaps in React NodeViews via `withNodeViews()`.
 *
 * Structure rule: `columns` is in group "layout", everything else in "block".
 * The doc takes (block | layout)+, while column, blockquote and list item take
 * block content, so nested columns cannot be represented.
 */

// ── Attribute helpers ────────────────────────────────────────────────────────

/** Attributes round-trip through `data-*` so copy/paste inside the editor keeps them. */
function dataAttrs(defaults: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(defaults).map(([name, fallback]) => [
      name,
      {
        default: fallback,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute(`data-${name.toLowerCase()}`);
          if (raw === null) return fallback;
          try {
            return JSON.parse(raw);
          } catch {
            return raw;
          }
        },
        renderHTML: (a: Record<string, unknown>) =>
          a[name] === null || a[name] === undefined ? {} : { [`data-${name.toLowerCase()}`]: JSON.stringify(a[name]) },
      },
    ]),
  );
}

/** An atom block rendered in the editor as a tagged <div> (React NodeViews replace it). */
function atomBlock(name: string, defaults: Record<string, unknown>) {
  return Node.create({
    name,
    group: "block",
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes: () => dataAttrs({ v: 1, ...defaults }),
    // Only our own serialization parses back: pasted foreign HTML never becomes these nodes.
    parseHTML: () => [{ tag: `div[data-forge-node="${name}"]` }],
    renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-forge-node": name })],
  });
}

// ── Custom nodes ─────────────────────────────────────────────────────────────

export const ImageNode = atomBlock("image", {
  mediaId: null,
  alt: null,
  caption: null,
  size: "content",
  link: null,
});

export const ButtonNode = atomBlock("button", {
  label: "Button",
  href: "/",
  style: "primary",
  align: "start",
  newTab: false,
});

export const EmbedNode = atomBlock("embed", { provider: "youtube", url: "", aspect: "16:9" });

export const SpacerNode = atomBlock("spacer", { size: "md" });

const EQUAL_RATIO: Record<number, string> = { 2: "1:1", 3: "1:1:1" };

export const ColumnsNode = Node.create({
  name: "columns",
  group: "layout",
  content: "column{2,3}",
  isolating: true,
  defining: true,
  draggable: true,
  addAttributes: () => dataAttrs({ v: 1, count: 2, ratio: "1:1", stackOnMobile: true }),
  parseHTML: () => [{ tag: 'div[data-forge-node="columns"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-forge-node": "columns" }), 0],
  // `count` and `ratio` restate the number of children, which pasting a partial
  // selection or deleting a column can change. Keep them in sync after every
  // transaction, or the document fails validation and autosave stalls.
  addProseMirrorPlugins: () => [
    new Plugin({
      key: new PluginKey("columnsNormalize"),
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some((t) => t.docChanged)) return null;
        const tr = state.tr;
        state.doc.descendants((node, pos) => {
          if (node.type.name !== "columns") return;
          const count = node.childCount;
          const ratio = String(node.attrs.ratio ?? "").split(":").length === count ? node.attrs.ratio : EQUAL_RATIO[count];
          if (node.attrs.count !== count || node.attrs.ratio !== ratio) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, count, ratio });
          }
          return false; // columns never nest
        });
        return tr.steps.length ? tr.setMeta("addToHistory", false) : null;
      },
    }),
  ],
});

export const ColumnNode = Node.create({
  name: "column",
  content: "block+",
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-forge-node="column"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-forge-node": "column" }), 0],
});

// ── Native nodes with our attributes ─────────────────────────────────────────

const ForgeDocument = Document.extend({ content: "(block | layout)+" });

const ForgeBlockquote = Blockquote.extend({
  addAttributes: () => ({ cite: { default: null } }),
});

// `style` would collide with the HTML style attribute, so it travels as data-style.
const ForgeHorizontalRule = HorizontalRule.extend({
  addAttributes: () => dataAttrs({ style: "line" }),
});

// ── Keyboard reorder (Alt+↑ / Alt+↓) ─────────────────────────────────────────

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockMove: {
      moveBlockUp: () => ReturnType;
      moveBlockDown: () => ReturnType;
    };
  }
}

/** Swaps the top-level block holding the selection with its neighbour; one undo step. */
function moveTopLevelBlock(direction: -1 | 1) {
  return ({ state, dispatch }: CommandProps) => {
    const { selection, doc } = state;
    const index = selection.$from.index(0);
    if (selection.$to.index(0) !== index) return false; // selection spans blocks
    const target = index + direction;
    if (target < 0 || target >= doc.childCount) return false;
    if (dispatch) {
      let start = 0;
      for (let i = 0; i < Math.min(index, target); i++) start += doc.child(i).nodeSize;
      const [first, second] = direction === -1 ? [doc.child(index), doc.child(target)] : [doc.child(target), doc.child(index)];
      const end = start + first.nodeSize + second.nodeSize;
      const delta = direction === -1 ? -doc.child(target).nodeSize : doc.child(target).nodeSize;
      const tr = state.tr.replaceWith(start, end, [first, second]);
      tr.setSelection(
        selection instanceof NodeSelection
          ? NodeSelection.create(tr.doc, selection.from + delta)
          : TextSelection.create(tr.doc, selection.anchor + delta, selection.head + delta),
      );
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export const BlockMove = Extension.create({
  name: "blockMove",
  addCommands: () => ({ moveBlockUp: () => moveTopLevelBlock(-1), moveBlockDown: () => moveTopLevelBlock(1) }),
  addKeyboardShortcuts() {
    return {
      "Alt-ArrowUp": () => this.editor.commands.moveBlockUp(),
      "Alt-ArrowDown": () => this.editor.commands.moveBlockDown(),
    };
  },
});

// ── Paste guard ──────────────────────────────────────────────────────────────

const VALIDATED = new Set(["image", "button", "embed", "spacer", "columns"]);
const PLACEHOLDER_ID = "00000000-0000-7000-8000-000000000000"; // ids are (re)assigned by UniqueID after paste

function validAttrs(node: PMNode): boolean {
  const schema = attrSchemas[node.type.name as keyof typeof attrSchemas];
  return schema.safeParse({ ...node.attrs, id: PLACEHOLDER_ID }).success;
}

function cleanFragment(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    if (VALIDATED.has(node.type.name) && !validAttrs(node)) return;
    if (node.isText || node.isLeaf) return void nodes.push(node);
    let content = cleanFragment(node.content);
    if (content.size === 0 && node.type.name === "column") {
      content = Fragment.from(node.type.schema.nodes.paragraph!.create());
    }
    nodes.push(node.copy(content));
  });
  return Fragment.fromArray(nodes);
}

/**
 * Custom-node attributes arriving by paste are untrusted: anyone can put
 * `data-forge-node="button" data-href="javascript:…"` on a web page. Drop
 * custom nodes whose attributes fail their Zod schema before they enter the
 * document. (Save and render validate again.)
 */
export const PasteGuard = Extension.create({
  name: "pasteGuard",
  addProseMirrorPlugins: () => [
    new Plugin({
      key: new PluginKey("pasteGuard"),
      props: {
        transformPasted: (slice) => new Slice(cleanFragment(slice.content), slice.openStart, slice.openEnd),
      },
    }),
  ],
});

// ── The extension set ────────────────────────────────────────────────────────

/** Node types that carry a stable `id` (every top-level and every custom node). */
export const ID_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "horizontalRule",
  "image",
  "button",
  "columns",
  "column",
  "embed",
  "spacer",
];

export const forgeExtensions: AnyExtension[] = [
  StarterKit.configure({
    document: false,
    blockquote: false,
    horizontalRule: false,
    codeBlock: false, // not in the V1 block set
    hardBreak: false, // not in the V1 block set
    heading: { levels: [2, 3, 4] },
    link: {
      openOnClick: false,
      autolink: true,
      protocols: ["mailto", "tel"],
      HTMLAttributes: { target: null, rel: null, class: null },
      isAllowedUri: (url) => isSafeHref(url),
      shouldAutoLink: (url) => isSafeHref(url),
    },
  }),
  ForgeDocument,
  ForgeBlockquote,
  ForgeHorizontalRule,
  ImageNode,
  ButtonNode,
  EmbedNode,
  SpacerNode,
  ColumnsNode,
  ColumnNode,
  BlockMove,
  PasteGuard,
  UniqueID.configure({ types: ID_TYPES, attributeName: "id", generateID: () => uuidv7() }),
];
