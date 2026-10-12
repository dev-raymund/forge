import { z } from "zod";
import { blockId, defineBlock } from "../define";

/**
 * Columns (plan §6.1): 2 or 3 columns, each holding any block except columns.
 * `count` and `ratio` restate the number of columns; the editor keeps them in
 * step with the columns that are there (ADR 0003 gap 2), so `count` is not a
 * field of the panel: columns are added and removed as columns.
 */
export const RATIOS: Readonly<Record<2 | 3, readonly string[]>> = { 2: ["1:1", "2:1", "1:2"], 3: ["1:1:1", "2:1:1", "1:2:1", "1:1:2"] };
const ALL_RATIOS = [...RATIOS[2], ...RATIOS[3]] as [string, ...string[]];
const RATIO_LABELS: Record<string, string> = {
  "1:1": "Equal", "2:1": "Wide, narrow", "1:2": "Narrow, wide", "1:1:1": "Equal", "2:1:1": "Wide, narrow, narrow", "1:2:1": "Narrow, wide, narrow", "1:1:2": "Narrow, narrow, wide",
};

export const columns = defineBlock({
  type: "columns",
  label: "Columns",
  v: 1,
  migrate: {},
  attrs: z
    .object({
      id: blockId,
      v: z.literal(1).meta({ hidden: true }),
      count: z.union([z.literal(2), z.literal(3)]).meta({ hidden: true }),
      ratio: z.enum(ALL_RATIOS).default("1:1").meta({ title: "Widths", options: RATIO_LABELS }),
      stackOnMobile: z.boolean().default(true).meta({ title: "One below the other on phones" }),
    })
    .refine((attrs) => attrs.ratio.split(":").length === attrs.count, { message: "Choose widths for this number of columns.", path: ["ratio"] }),
  defaults: { v: 1, count: 2, ratio: "1:1", stackOnMobile: true },
  editable: true,
});

/** One column of a columns block: blocks, but never columns. */
export const column = defineBlock({
  type: "column",
  label: "Column",
  v: 1,
  migrate: {},
  attrs: z.object({ id: blockId }),
  defaults: {},
  editable: true,
});
