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
