import type { ThemeContext } from "../types";

/**
 * A link a site's settings point at, as the page must write it: a path on the
 * site gets the site's base (`/contact` → `/s/acme/contact` in V1); a full
 * address is left as it is. Values reach here already validated (`safeHref`).
 */
export function siteHref(context: ThemeContext, href: string): string {
  return href.startsWith("/") ? `${context.site.basePath}${href}` || "/" : href;
}
