import "server-only";
import { cache } from "react";
import { siteBasePath, type SiteLocator } from "@/platform/routing/hosts";
import type { RenderableSite } from "@/themes/render";
import { loadPublicSite, resolveSite, type PublicSite } from "./queries";

/**
 * A request's site, resolved once (M4-3). The layout, the page, its metadata
 * and the not-found page all ask; `cache` makes it one lookup per request,
 * on top of the cached data functions.
 */
export const publicSiteFor = cache(async (locator: SiteLocator): Promise<PublicSite | null> => {
  const resolved = await resolveSite(locator);
  if (!resolved) return null;
  return loadPublicSite(resolved.orgId, resolved.siteId);
});

/** `<html lang>`: the site's language if it has the shape of one, otherwise English. */
export function htmlLang(site: Pick<PublicSite, "language"> | null): string {
  return site && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(site.language) ? site.language : "en";
}

/**
 * What the theme is handed (ADR 0012 `RenderableSite`): the site's public
 * words, its base path for links, its theme and settings. Nothing else of the
 * site, and nothing of anyone.
 */
export function renderableSite(site: PublicSite, locator: SiteLocator): RenderableSite {
  return {
    name: site.name,
    tagline: site.tagline,
    language: htmlLang(site),
    basePath: siteBasePath(locator),
    themeKey: site.themeKey,
    themeSettings: site.themeSettings,
    social: site.social,
  };
}

/**
 * The site the layout resolved, for the not-found page of the same request:
 * Next hands a not-found page no params, and it must know whose theme to draw.
 * Set by the layout before any child renders; per request (`cache`).
 */
const resolvedForRequest = cache((): { locator: SiteLocator | null; site: PublicSite | null } => ({ locator: null, site: null }));

export function rememberRequestSite(locator: SiteLocator, site: PublicSite | null): void {
  const slot = resolvedForRequest();
  slot.locator = locator;
  slot.site = site;
}

export function requestSite(): { locator: SiteLocator | null; site: PublicSite | null } {
  return resolvedForRequest();
}
