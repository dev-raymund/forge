"use client";

import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";

/** A button in the editor: its text, and where it goes, as text (never a live link: attributes are untrusted until saved). */
export function ButtonView({ node, selected }: ReactNodeViewProps) {
  const { label, href, style, align } = node.attrs as { label: string; href: string; style: string; align: string };
  return (
    <NodeViewWrapper data-forge-node="button" data-testid="block-button" className={`forge-block forge-block--button forge-align-${align} ${selected ? "is-selected" : ""}`}>
      <span className={`forge-block-button forge-block-button--${style}`}>{label || "Button"}</span>
      <span className="forge-block-muted">→ {href}</span>
    </NodeViewWrapper>
  );
}
