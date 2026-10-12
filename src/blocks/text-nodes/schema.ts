import { z } from "zod";
import { blockId } from "../define";

/**
 * The text nodes' attributes (plan §6.1; from the M0-5 spike, ADR 0003). Only
 * the top-level nodes carry an id; list items and text carry none.
 */
const text = (max: number) => z.string().max(max);

export const textNodeAttrs = {
  paragraph: z.object({ id: blockId }),
  heading: z.object({ id: blockId, level: z.union([z.literal(2), z.literal(3), z.literal(4)]) }),
  blockquote: z.object({ id: blockId, cite: text(200).nullable().default(null) }),
  bulletList: z.object({ id: blockId }),
  orderedList: z.object({ id: blockId, start: z.int().min(1).max(10_000).default(1) }),
  horizontalRule: z.object({ id: blockId, style: z.enum(["line", "space"]).default("line") }),
} as const;
