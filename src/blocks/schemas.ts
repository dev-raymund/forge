import type { z } from "zod";
import { button } from "./button/schema";
import { column, columns } from "./columns/schema";
import type { BlockMigrations, BlockSchema } from "./define";
import { embed } from "./embed/schema";
import { image } from "./image/schema";
import { spacer } from "./spacer/schema";
import { textNodeAttrs } from "./text-nodes/schema";

/**
 * The block registry's schemas (M5-5): every node type a stored document may
 * hold, with its attributes, and the custom blocks' versions and migrations.
 * Pure and client-safe. The document's validation (`modules/content/document`)
 * is built from this; the editor (./editor.ts) and the renderers (./render.tsx)
 * are the registry's other two faces, and a test keeps the three in step.
 */
export const CUSTOM_BLOCKS: readonly BlockSchema[] = [button, columns, column, embed, spacer, image];

export const blockSchema = (type: unknown): BlockSchema | null => CUSTOM_BLOCKS.find((block) => block.type === type) ?? null;

/** The custom blocks the editor creates and edits (all but the image, M6-4). */
export const EDITABLE_BLOCK_TYPES: readonly string[] = CUSTOM_BLOCKS.filter((block) => block.editable).map((block) => block.type);

/** Every node type's attributes. */
export const NODE_ATTRS = {
  ...textNodeAttrs,
  image: image.attrs,
  button: button.attrs,
  columns: columns.attrs,
  column: column.attrs,
  embed: embed.attrs,
  spacer: spacer.attrs,
} satisfies Record<string, z.ZodType>;

/** `v` and `migrate` of every versioned block, for reading old documents (ADR 0003). */
export const NODE_MIGRATIONS: Readonly<Record<string, { v: number; migrate: BlockMigrations }>> = Object.fromEntries(
  CUSTOM_BLOCKS.filter((block) => block.type !== "column").map((block) => [block.type, { v: block.v, migrate: block.migrate }]),
);

export { button, column, columns, embed, image, spacer };
