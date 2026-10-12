import type { ReactNode } from "react";
import { renderButton } from "./button/render";
import { renderColumns } from "./columns/render";
import { renderEmbed } from "./embed/render";
import type { BlockRenderContext } from "./render-context";
import { renderSpacer } from "./spacer/render";

/**
 * The block registry's render face (M5-5): one renderer per editable custom
 * block, emitting only fixed elements (no stored HTML, no
 * `dangerouslySetInnerHTML`) from attributes it validates itself. The
 * document renderer that walks a whole document and the theme's styles for
 * these elements are M5-6's. The image's renderer (`ResponsiveImage`) is M6-4's.
 */
export type BlockRenderer = (input: { attrs: unknown; children: readonly ReactNode[]; context: BlockRenderContext }) => ReactNode;

export const BLOCK_RENDERERS: Readonly<Record<string, BlockRenderer>> = {
  button: ({ attrs, context }) => renderButton(attrs, context),
  columns: ({ attrs, children }) => renderColumns(attrs, children),
  embed: ({ attrs, context }) => renderEmbed(attrs, context),
  spacer: ({ attrs }) => renderSpacer(attrs),
};

export type { BlockRenderContext } from "./render-context";
