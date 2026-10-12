import type { AnyExtension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import UniqueID from "@tiptap/extension-unique-id";
import { uuidv7 } from "uuidv7";
import { BLOCK_EDITORS, customBlockNodes } from "@/blocks/editor";
import { PasteGuard } from "@/blocks/paste-guard";
import { TEXT_ID_TYPES, TEXT_NODE_TYPES, textNodes } from "@/blocks/text-nodes/extensions";
import { BlockMove, SnapDrop } from "./reorder";

/**
 * The editor's whole schema and behaviour (M5-5): the text nodes, the custom
 * blocks of the registry, stable ids, the paste guard and reordering. One
 * list, for the editor and its tests (which leave out the React NodeViews).
 */

/** The document holds blocks, and layouts (columns) at the top level only: columns cannot nest (ADR 0003). */
const ForgeDocument = Document.extend({ content: "(block | layout)+" });

/** Node types that carry a stable `id` (plan §6.2): every top-level node and every custom block. */
export const ID_TYPES: readonly string[] = [...TEXT_ID_TYPES, ...BLOCK_EDITORS.map((block) => block.type)];

/** Every node type this editor can hold. A stored document with any other (the image, M6-4) is not opened for editing (it would lose them). */
export const EDITOR_NODE_TYPES: ReadonlySet<string> = new Set([...TEXT_NODE_TYPES, ...BLOCK_EDITORS.map((block) => block.type)]);

export function editorExtensions({ nodeViews = true }: { nodeViews?: boolean } = {}): AnyExtension[] {
  return [
    ...textNodes,
    ForgeDocument,
    ...customBlockNodes({ nodeViews }),
    PasteGuard,
    BlockMove,
    SnapDrop,
    UniqueID.configure({ types: [...ID_TYPES], attributeName: "id", generateID: () => uuidv7() }),
  ];
}
