import "server-only";

/**
 * Public server API of the rendering module (M4-3, ADR 0013): from a site's
 * address to what its visitors see. Used only by the site tree,
 * `app/(sites)/render/*`, which never imports the auth module (lint).
 */
export { loadPublicSite, resolveSite } from "./queries";
export type { PublicSite, ResolvedSite } from "./queries";
export { htmlLang, publicSiteFor, rememberRequestSite, renderableSite, requestSite } from "./public-site";
export { HTTP_STATUS, isShowable, renderStateFor, robotsFor } from "./render-state";
export type { RenderState, RenderStateKind } from "./render-state";
export { SiteNotFound, SiteUnavailable } from "./ui/platform-pages";
export { safeAnalytics, SiteAnalytics } from "./ui/analytics";
