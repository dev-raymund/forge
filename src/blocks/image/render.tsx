import type { ReactNode } from "react";
import { ResponsiveImage } from "@/themes/_kit/components/responsive-image";
import { resolveHref, type BlockRenderContext } from "../render-context";
import { image } from "./schema";

/** How wide the image is drawn for each size, for the browser's choice among the widths it has (`sizes`). */
const SIZES = {
  content: "(min-width: 48rem) 48rem, 100vw",
  wide: "(min-width: 72rem) 72rem, 100vw",
  full: "100vw",
} as const;

/**
 * An image on the public site (M6-4): `<figure>` with `<ResponsiveImage>` (every width the image is stored at, from
 * `/media`; never the original) and the caption. The media item is looked up through the render context, never
 * from a stored URL: one that is missing, trashed, not an image or not this site's renders nothing at all. The alt
 * text is the block's, else the image's own. A link that resolves to nothing (a page that is not live) drops the link,
 * not the image.
 */
export function renderImage(attrs: unknown, context: BlockRenderContext): ReactNode {
  const parsed = image.attrs.safeParse(attrs);
  if (!parsed.success) return null;
  const { mediaId, alt, caption, size, link } = parsed.data;
  const media = context.resolveImage?.(mediaId);
  if (!media || !media.sources.length) return null;
  const picture = <ResponsiveImage image={{ alt: alt ?? media.alt, width: media.width, height: media.height, sources: media.sources }} sizes={SIZES[size]} />;
  const target = link ? resolveHref(link, context) : undefined;
  return (
    <figure className={`forge-image forge-image--${size}`}>
      {target ? <a href={target}>{picture}</a> : picture}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
