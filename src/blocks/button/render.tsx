import type { ReactNode } from "react";
import { entryIdOf, isSafeHref } from "../links";
import type { BlockRenderContext } from "../render-context";
import { button } from "./schema";

/** A button on the public site (M5-5; drawn by the theme's styles, M5-6). Invalid attributes, or a link that resolves to nothing, render nothing. */
export function renderButton(attrs: unknown, context: BlockRenderContext): ReactNode {
  const parsed = button.attrs.safeParse(attrs);
  if (!parsed.success) return null;
  const { label, href, style, align, newTab } = parsed.data;
  const target = !isSafeHref(href) ? undefined : (entryIdOf(href) ? context.resolveEntryHref(entryIdOf(href)!) : href);
  if (!target) return null;
  return (
    <div className={`forge-button-row forge-button-row--${align}`}>
      <a href={target} className={`forge-button forge-button--${style}`} {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {label}
      </a>
    </div>
  );
}
