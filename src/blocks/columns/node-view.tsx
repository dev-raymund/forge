"use client";

import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";

/** Columns in the editor: the columns side by side at their widths; each column is edited in place. */
export function ColumnsView({ node, selected, editor, getPos }: ReactNodeViewProps) {
  const { count, ratio } = node.attrs as { count: number; ratio: string };
  const template = ratio
    .split(":")
    .map((part) => `${Number(part)}fr`)
    .join(" ");
  return (
    <NodeViewWrapper
      data-forge-node="columns"
      data-testid="block-columns"
      className={`forge-block forge-block--columns ${selected ? "is-selected" : ""}`}
      style={{ "--forge-columns": template } as React.CSSProperties}
    >
      <button
        type="button"
        contentEditable={false}
        className="forge-block-label forge-block-select"
        onClick={() => {
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (typeof pos === "number") editor.chain().focus().setNodeSelection(pos).run();
        }}
      >
        Columns · {count}
      </button>
      <NodeViewContent className="forge-block-columns" />
    </NodeViewWrapper>
  );
}
