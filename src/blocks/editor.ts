import type { AnyExtension, JSONContent } from "@tiptap/core";
import { ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import type { ComponentType } from "react";
import { ButtonNode } from "./button/extension";
import { ButtonView } from "./button/node-view";
import { button } from "./button/schema";
import { ColumnNode, ColumnsNode, newColumns } from "./columns/extension";
import { ColumnsView } from "./columns/node-view";
import { EmbedNode } from "./embed/extension";
import { EmbedView } from "./embed/node-view";
import { ImageNode } from "./image/extension";
import { ImageView } from "./image/node-view";
import { SpacerNode } from "./spacer/extension";
import { SpacerView } from "./spacer/node-view";
import { spacer } from "./spacer/schema";

/**
 * The block registry's editor face (M5-5): each editable custom block's Tiptap
 * node, its React NodeView, and how the slash menu inserts it. Client-only
 * (React NodeViews). The schemas are ./schemas.ts, the renderers ./render.tsx.
 */

export type BlockInsert = {
  key: string;
  label: string;
  keywords: readonly string[];
  /** The node to insert; `address` blocks (embeds) ask for one first, `media` blocks (images) for a media item (M6-4). */
  content: () => JSONContent;
  asks?: "address" | "media";
  /** A layout (columns): only at the top level, never inside a column. */
  layout?: true;
};

export type BlockEditor = { type: string; node: AnyExtension; view?: ComponentType<ReactNodeViewProps>; inserts: readonly BlockInsert[] };

export const BLOCK_EDITORS: readonly BlockEditor[] = [
  {
    type: "button",
    node: ButtonNode,
    view: ButtonView,
    inserts: [{ key: "button", label: "Button", keywords: ["button", "call to action", "cta", "link"], content: () => ({ type: "button", attrs: { ...button.defaults } }) }],
  },
  {
    type: "columns",
    node: ColumnsNode,
    view: ColumnsView,
    inserts: [
      { key: "columns-2", label: "Two columns", keywords: ["columns", "layout", "two", "2"], content: () => newColumns(2), layout: true },
      { key: "columns-3", label: "Three columns", keywords: ["columns", "layout", "three", "3"], content: () => newColumns(3), layout: true },
    ],
  },
  { type: "column", node: ColumnNode, inserts: [] },
  {
    type: "embed",
    node: EmbedNode,
    view: EmbedView,
    inserts: [{ key: "embed", label: "Video or embed", keywords: ["video", "youtube", "vimeo", "embed", "iframe", "map"], content: () => ({ type: "embed" }), asks: "address" }],
  },
  {
    type: "image",
    node: ImageNode,
    view: ImageView,
    // Never inserted without a media item: the editor opens the picker first (M6-4).
    inserts: [{ key: "image", label: "Image", keywords: ["image", "picture", "photo", "media", "img"], content: () => ({ type: "image" }), asks: "media" }],
  },
  {
    type: "spacer",
    node: SpacerNode,
    view: SpacerView,
    inserts: [{ key: "spacer", label: "Spacer", keywords: ["spacer", "space", "gap"], content: () => ({ type: "spacer", attrs: { ...spacer.defaults } }) }],
  },
];

/** The custom blocks' nodes, with their React NodeViews when `nodeViews` (headless tests leave them out). */
export function customBlockNodes({ nodeViews }: { nodeViews: boolean }): AnyExtension[] {
  return BLOCK_EDITORS.map(({ node, view }) => (nodeViews && view ? node.extend({ addNodeView: () => ReactNodeViewRenderer(view) }) : node));
}

export const BLOCK_INSERTS: readonly BlockInsert[] = BLOCK_EDITORS.flatMap((block) => block.inserts);
