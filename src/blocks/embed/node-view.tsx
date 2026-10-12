"use client";

import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";

const KINDS: Record<string, string> = { youtube: "YouTube video", vimeo: "Vimeo video", generic: "Embedded page" };

/** An embed in the editor: what it is and its address. Nothing third-party is loaded into the admin. */
export function EmbedView({ node, selected }: ReactNodeViewProps) {
  const { provider, url, aspect } = node.attrs as { provider: string; url: string; aspect: string };
  return (
    <NodeViewWrapper data-forge-node="embed" data-testid="block-embed" className={`forge-block forge-block--embed ${selected ? "is-selected" : ""}`}>
      <span className="forge-block-label">
        {KINDS[provider] ?? "Embed"} · {aspect}
      </span>
      <span className="forge-block-muted forge-block-url">{url}</span>
    </NodeViewWrapper>
  );
}
