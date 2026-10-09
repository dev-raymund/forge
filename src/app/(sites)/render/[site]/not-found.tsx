import { isShowable, renderableSite, requestSite, SiteNotFound, SiteUnavailable } from "@/modules/rendering";
import { themeFor } from "@/themes/render";

/**
 * The 404 answers of a tenant site (M4-3, ADR 0013), inside the layout of the
 * same request. Next hands this page no params, so it takes the site the
 * layout resolved (`requestSite`):
 *
 *   no site at the address   the platform's "Site not found"
 *   a site it cannot show    the platform's "This site is unavailable"
 *   a page the site lacks    the site's theme's not-found template (the layout already drew the theme's frame)
 */
export default function SiteNotFoundPage() {
  const { locator, site } = requestSite();
  if (!site || !locator) return <SiteNotFound />;
  if (!isShowable(site)) return <SiteUnavailable />;
  const { theme, context } = themeFor(renderableSite(site, locator));
  const NotFound = theme.templates["not-found"];
  return <NotFound context={context} />;
}
