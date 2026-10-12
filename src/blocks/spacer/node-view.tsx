"use client";

import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";

const SIZES: Record<string, string> = { sm: "Small", md: "Medium", lg: "Large", xl: "Extra large" };

export function SpacerView({ node, selected }: ReactNodeViewProps) {
  const { size } = node.attrs as { size: string };
  return (
    <NodeViewWrapper data-forge-node="spacer" data-testid="block-spacer" className={`forge-block forge-block--spacer forge-spacer-${size} ${selected ? "is-selected" : ""}`}>
      <span className="forge-block-label">Spacer · {SIZES[size] ?? size}</span>
    </NodeViewWrapper>
  );
}
