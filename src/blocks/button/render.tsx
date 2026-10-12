import type { ReactNode } from "react";
import { resolveHref, type BlockRenderContext } from "../render-context";
import { button } from "./schema";

/**
 * A button on the public site (M5-5; drawn by the theme's styles, M5-6). Invalid attributes, or a link that resolves
 * to nothing (a page that is not live, another site's), render nothing: a button that goes nowhere is not drawn.
 */
export function renderButton(attrs: unknown, context: BlockRenderContext): ReactNode {
  const parsed = button.attrs.safeParse(attrs);
  if (!parsed.success) return null;
  const { label, href, style, align, newTab } = parsed.data;
  const target = resolveHref(href, context);
  if (!target) return null;
  return (
    <div className={`forge-button-row forge-button-row--${align}`}>
      <a href={target} className={`forge-button forge-button--${style}`} {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {label}
      </a>
    </div>
  );
}
