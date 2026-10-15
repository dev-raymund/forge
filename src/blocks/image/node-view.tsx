"use client";

import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useImagePreview } from "./preview-context";

const SIZES: Record<string, string> = { content: "Text width", wide: "Wide", full: "Full width" };

/**
 * An image in the editor (M6-4): its name and size, and its square thumbnail (a variant from this site's `/media`,
 * never the original) once the person asks for previews; nothing is loaded before that. An image the editor does not
 * know any more (trashed, removed) says so: the public page draws nothing for it.
 */
export function ImageView({ node, selected }: ReactNodeViewProps) {
  const { mediaId, alt, caption, size } = node.attrs as { mediaId: string; alt: string | null; caption: string | null; size: string };
  const { preview, shown, show } = useImagePreview(mediaId);
  return (
    <NodeViewWrapper data-forge-node="image" data-testid="block-image" data-media-id={mediaId} className={`forge-block forge-block--image ${selected ? "is-selected" : ""}`}>
      {preview?.thumbUrl && shown ? (
        // eslint-disable-next-line @next/next/no-img-element -- the site's own thumbnail variant, from /media
        <img src={preview.thumbUrl} alt={alt ?? preview.altText} width={96} height={96} className="forge-block-thumb" draggable={false} />
      ) : null}
      {preview?.thumbUrl && !shown ? (
        // A button inside a node view is the button's: the editor leaves its click alone.
        <button type="button" className="forge-block-action" onClick={show} data-testid="show-image-previews">
          Show previews
        </button>
      ) : null}
      <span className="forge-block-label">
        Image · {SIZES[size] ?? size}
        {preview ? ` · ${preview.name}` : ""}
      </span>
      {preview ? (
        caption ? <span className="forge-block-muted">{caption}</span> : null
      ) : (
        <span className="forge-block-muted" data-testid="image-unavailable">
          This image is no longer in the media library. It is not shown on the site. Choose another one.
        </span>
      )}
    </NodeViewWrapper>
  );
}
