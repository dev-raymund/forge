import "server-only";

/**
 * Public server API of the rendering module (M4-3, ADR 0013; M5-6): from a site's
 * address and a path to what its visitors see. Used only by the site tree,
 * `app/(sites)/render/*`, which never imports the auth module (lint).
 */
export { loadPublicSite, resolveSite } from "./queries";
export type { PublicSite, ResolvedSite } from "./queries";
export { htmlLang, publicSiteFor, rememberRequestSite, renderableSite, requestSite } from "./public-site";
export { HTTP_STATUS, isShowable, renderStateFor, robotsFor } from "./render-state";
export type { RenderState, RenderStateKind } from "./render-state";
export { SiteNotFound, SiteUnavailable } from "./ui/platform-pages";
export { ANALYTICS_SCRIPTS_ACTIVE, emitsAnalytics, safeAnalytics, SiteAnalytics } from "./ui/analytics";
// M5-6: content.
export { livePaths, loadEntry, loadPostList, resolveRoute } from "./content";
export type { PostSummary, PublicTerm, PublishedEntry, RouteMatch } from "./content";
export { publicPageFor } from "./public-page";
export type { PublicPage } from "./public-page";
export { PublicPageView, publicPageTitle } from "./ui/public-page";
export { renderDocument, RENDERED_ELEMENTS } from "./document";
export type { DocumentRenderContext, SkipReason } from "./document";
export { listPageHref, routeFor } from "./routes";
export type { RouteCandidate } from "./routes";
// M7-4: previews of a draft or a revision, for the person a preview token names (ADR 0027).
export { loadPreview } from "./preview";
export type { Preview, PreviewGaps, PreviewSubject } from "./preview";
export { AppearancePreviewView, previewLines, PreviewUnavailable, PreviewView } from "./ui/preview-page";
// M8-4: what a site says to search engines (ADR 0031).
export { liveTitlesAt, loadSitemapRows, SITEMAP_ENTRIES_MAX } from "./content";
export type { SitemapRows } from "./content";
export { indexableSiteAddresses, ROBOTS_SITES_MAX } from "./queries";
export { indexableNotice, publicPageSeo, publicStructuredData, searchIndexingAllowed, seoImage, seoMetadata, seoPageOf, siteBaseUrl, sitemapUrlsOf } from "./seo";
export { JsonLd } from "./ui/json-ld";
// M8-3: the site's menus, as its visitors see them (ADR 0030).
export { loadMenus, menuNavItems, publicMenusFor } from "./menus";
export type { PublicMenuLink, PublicMenus } from "./menus";
// M8-1: the appearance editor's live preview (ADR 0028).
export { loadAppearancePreview } from "./appearance-preview";
export type { AppearancePreview } from "./appearance-preview";
