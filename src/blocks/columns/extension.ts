import { mergeAttributes, Node } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { dataAttrs } from "../node-html";
import { columns, RATIOS } from "./schema";

/**
 * Columns in the editor (plan §6.1; from the M0-5 spike). `columns` is in the
 * group "layout"; a column, a quote and a list item hold "block" content; so
 * columns inside columns cannot be represented at all (ADR 0003).
 */
export const ColumnsNode = Node.create({
  name: "columns",
  group: "layout",
  content: "column{2,3}",
  isolating: true,
  defining: true,
  draggable: true,
  addAttributes: () => dataAttrs(columns.defaults),
  parseHTML: () => [{ tag: 'div[data-forge-node="columns"]' }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-forge-node": "columns" }), 0],
  // `count` and `ratio` restate the number of columns, which pasting part of a selection or removing a column changes.
  // Kept in step after every transaction, or the document fails validation and autosave stops (ADR 0003 gap 2).
  addProseMirrorPlugins: () => [
    new Plugin({
      key: new PluginKey("columnsNormalize"),
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some((transaction) => transaction.docChanged)) return null;
        const tr = state.tr;
        state.doc.descendants((node, pos) => {
          if (node.type.name !== "columns") return;
          const count = node.childCount;
          const fits = (RATIOS[count as 2 | 3] ?? []).includes(node.attrs.ratio as string);
          const ratio = fits ? node.attrs.ratio : RATIOS[count as 2 | 3]?.[0];
          if (node.attrs.count !== count || node.attrs.ratio !== ratio) tr.setNodeMarkup(pos, undefined, { ...node.attrs, count, ratio });
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

/** A new columns block: `count` columns, each with an empty paragraph to type in. */
export function newColumns(count: 2 | 3) {
  return {
    type: "columns",
    attrs: { ...columns.defaults, count, ratio: RATIOS[count][0] },
    content: Array.from({ length: count }, () => ({ type: "column", content: [{ type: "paragraph" }] })),
  };
}
