import { z } from "zod";
import { blockId, defineBlock } from "../define";
import { isSafeHref, LINK_MAX } from "../links";

/**
 * An image (plan §6.1). Its attributes are part of the stored document's
 * contract since the M0-5 spike (M6-4 adds only the panel's hints), and the
 * server checks that `mediaId` is a usable image of the same site (M5-5,
 * M6-1). It is chosen with the media picker (M6-4, `widget: "media"`), never
 * typed; `alt` overrides the image's own alternative text when it is set.
 * Drawn on the public site with `ResponsiveImage` (./render.tsx).
 */
export const image = defineBlock({
  type: "image",
  label: "Image",
  v: 1,
  migrate: {},
  attrs: z.object({
    id: blockId,
    v: z.literal(1),
    mediaId: z.uuid().meta({ title: "Image", widget: "media" }),
    alt: z
      .string()
      .max(500)
      .nullable()
      .default(null)
      .meta({ title: "Alternative text", description: "What the image shows, for people who cannot see it. Empty: the image's own, from the media library." }),
    caption: z.string().max(1000).nullable().default(null).meta({ title: "Caption" }),
    size: z.enum(["content", "wide", "full"]).default("content").meta({ title: "Size", options: { content: "Text width", wide: "Wide", full: "Full width" } }),
    link: z.string().max(LINK_MAX).refine(isSafeHref, "Unsupported link").nullable().default(null).meta({ title: "Link", widget: "link" }),
  }),
  // A new image is created from a choice in the picker (the editor asks for it first), so there is no default media.
  defaults: { v: 1, size: "content", alt: null, caption: null, link: null },
  editable: true,
});
