"use client";

import type { AnyExtension } from "@tiptap/core";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";

/**
 * React NodeViews for the editor. Attributes arriving from paste are untrusted
 * until validated, so NodeViews show hrefs and urls as text and never as live links.
 */

function ImageView({ node, selected }: ReactNodeViewProps) {
  const { mediaId, alt, caption, size } = node.attrs as Record<string, string | null>;
  return (
    <NodeViewWrapper data-forge-node="image" className={`forge-nv forge-nv-image ${selected ? "is-selected" : ""}`}>
      <div className="forge-nv-label">Image · {size}</div>
      <div className="forge-nv-image-box" role="img" aria-label={alt ?? "image"}>
        media {String(mediaId).slice(0, 8)}…
      </div>
      {caption ? <div className="forge-nv-caption">{caption}</div> : null}
    </NodeViewWrapper>
  );
}

function ButtonView({ node, updateAttributes, selected }: ReactNodeViewProps) {
  const { label, href, style } = node.attrs as { label: string; href: string; style: string };
  return (
    <NodeViewWrapper data-forge-node="button" className={`forge-nv forge-nv-button ${selected ? "is-selected" : ""}`}>
      <input
        aria-label="Button label"
        className={`forge-nv-button-input forge-nv-button--${style}`}
        value={label}
        onChange={(e) => updateAttributes({ label: e.target.value })}
      />
      <span className="forge-nv-muted">→ {href}</span>
    </NodeViewWrapper>
  );
}

const RATIOS: Record<number, string[]> = { 2: ["1:1", "2:1", "1:2"], 3: ["1:1:1", "2:1:1", "1:2:1", "1:1:2"] };

function ColumnsView({ node, updateAttributes, selected }: ReactNodeViewProps) {
  const { count, ratio } = node.attrs as { count: number; ratio: string };
  const template = ratio.split(":").map((n) => `${Number(n)}fr`).join(" ");
  return (
    <NodeViewWrapper
      data-forge-node="columns"
      className={`forge-nv forge-nv-columns ${selected ? "is-selected" : ""}`}
      style={{ "--forge-cols": template } as React.CSSProperties}
    >
      <div className="forge-nv-label" contentEditable={false}>
        Columns ·{" "}
        {(RATIOS[count] ?? []).map((r) => (
          <button key={r} type="button" className={r === ratio ? "is-active" : ""} onClick={() => updateAttributes({ ratio: r })}>
            {r}
          </button>
        ))}
      </div>
      <NodeViewContent className="forge-nv-columns-content" />
    </NodeViewWrapper>
  );
}

const VIEWS: Record<string, (props: ReactNodeViewProps) => React.ReactNode> = {
  image: ImageView,
  button: ButtonView,
  columns: ColumnsView,
};

/** The shared extension set with React NodeViews attached (client only). */
export function withNodeViews(extensions: AnyExtension[]): AnyExtension[] {
  return extensions.map((ext) => {
    const view = VIEWS[ext.name];
    return view ? ext.extend({ addNodeView: () => ReactNodeViewRenderer(view) }) : ext;
  });
}
