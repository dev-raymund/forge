import { z } from "zod";
import { blockId, defineBlock } from "../define";
import { isSafeHref, LINK_MAX } from "../links";

/**
 * An image (plan §6.1). Its attributes are part of the stored document's
 * contract since the M0-5 spike, and the server checks that `mediaId` is a
 * media item of the same site (M5-5). Choosing an image, its editor, its
 * NodeView and its renderer (`ResponsiveImage`) are M6-4's: until then the
 * editor does not create or open images (`editable: false`).
 */
export const image = defineBlock({
  type: "image",
  label: "Image",
  v: 1,
  migrate: {},
  attrs: z.object({
    id: blockId,
    v: z.literal(1),
    mediaId: z.uuid(),
    alt: z.string().max(500).nullable().default(null),
    caption: z.string().max(1000).nullable().default(null),
    size: z.enum(["content", "wide", "full"]).default("content"),
    link: z.string().max(LINK_MAX).refine(isSafeHref, "Unsupported link").nullable().default(null),
  }),
  defaults: { v: 1, size: "content" },
  editable: false,
});
