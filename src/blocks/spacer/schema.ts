import { z } from "zod";
import { blockId, defineBlock } from "../define";

/** Vertical space (plan §6.1), in the theme's spacing steps. */
export const spacer = defineBlock({
  type: "spacer",
  label: "Spacer",
  v: 1,
  migrate: {},
  attrs: z.object({
    id: blockId,
    v: z.literal(1).meta({ hidden: true }),
    size: z.enum(["sm", "md", "lg", "xl"]).default("md").meta({ title: "Height", options: { sm: "Small", md: "Medium", lg: "Large", xl: "Extra large" } }),
  }),
  defaults: { v: 1, size: "md" },
  editable: true,
});
