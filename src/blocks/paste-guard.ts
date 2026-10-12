import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { blockSchema } from "./schemas";

/**
 * Pasted custom blocks are untrusted (ADR 0003 gap 1): any web page can carry
 * `<div data-forge-node="button" data-href="javascript:…">`. A pasted custom
 * block whose attributes fail its registry schema is dropped before it enters
 * the document; saving and rendering check again.
 */
const PLACEHOLDER_ID = "00000000-0000-7000-8000-000000000000"; // ids are (re)assigned by UniqueID after a paste

function validAttrs(node: PMNode): boolean {
  const block = blockSchema(node.type.name);
  if (!block || node.type.name === "column") return true;
  const attrs = { ...node.attrs, id: PLACEHOLDER_ID };
  // Part of a columns block can be pasted: `count` and `ratio` are re-synced with the columns that land (ColumnsNode),
  // so only the ratio's own validity is checked here, not whether it fits this slice.
  if (node.type.name === "columns") Object.assign(attrs, { count: String(node.attrs.ratio ?? "").split(":").length });
  return block.attrs.safeParse(attrs).success;
}

export function cleanFragment(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    if (!validAttrs(node)) return;
    if (node.isText || node.isLeaf) return void nodes.push(node);
    let content = cleanFragment(node.content);
    if (content.size === 0 && node.type.name === "column") content = Fragment.from(node.type.schema.nodes.paragraph!.create());
    nodes.push(node.copy(content));
  });
  return Fragment.fromArray(nodes);
}

export const PasteGuard = Extension.create({
  name: "pasteGuard",
  addProseMirrorPlugins: () => [
    new Plugin({ key: new PluginKey("pasteGuard"), props: { transformPasted: (slice) => new Slice(cleanFragment(slice.content), slice.openStart, slice.openEnd) } }),
  ],
});
