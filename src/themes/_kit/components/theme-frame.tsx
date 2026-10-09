import type { ThemeContext } from "../../types";
import { fontClasses } from "../fonts";
import { themeVariables } from "../tokens";
import "../kit.css";

/**
 * The outermost element of every page of a site: which theme draws it, the
 * site's fonts, and its settings as CSS custom properties (`themeVariables`,
 * built from validated values only and set as `style`, never as stylesheet
 * text). A link to skip to the content comes first.
 */
export function ThemeFrame({ theme, context, children }: { theme: string; context: ThemeContext; children: React.ReactNode }) {
  return (
    <div data-forge-theme="" data-theme={theme} className={fontClasses(context.settings)} style={themeVariables(context.settings) as React.CSSProperties}>
      <a href="#content" className="forge-skip-link">
        Skip to content
      </a>
      {children}
    </div>
  );
}

/** The site's home, from its base path: `/s/{address}` in V1, `/` on its own host later. */
export const homeHref = (context: ThemeContext): string => context.site.basePath || "/";
