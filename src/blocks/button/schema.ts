import { z } from "zod";
import { blockId, defineBlock } from "../define";
import { isSafeHref, LINK_MAX } from "../links";

/** A call to action (plan §6.1): a link drawn as the theme's button. */
export const button = defineBlock({
  type: "button",
  label: "Button",
  v: 1,
  migrate: {},
  attrs: z.object({
    id: blockId,
    v: z.literal(1).meta({ hidden: true }),
    label: z.string().trim().min(1, "Enter the button's text.").max(80, "Use at most 80 characters.").meta({ title: "Text" }),
    href: z
      .string()
      .trim()
      .max(LINK_MAX)
      .refine(isSafeHref, "Use an https:// address, mailto:, tel:, a path like /contact, or a page of this site.")
      .meta({ title: "Link", widget: "link" }),
    style: z.enum(["primary", "secondary"]).default("primary").meta({ title: "Style", options: { primary: "Primary", secondary: "Secondary" } }),
    align: z.enum(["start", "center", "end"]).default("start").meta({ title: "Alignment", options: { start: "Left", center: "Centre", end: "Right" } }),
    newTab: z.boolean().default(false).meta({ title: "Open in a new tab" }),
  }),
  defaults: { v: 1, label: "Button", href: "/", style: "primary", align: "start", newTab: false },
  editable: true,
});
