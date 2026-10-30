/**
 * Client-safe exports of the seo module (M8-4; plan §10; ADR 0031): the SEO settings' schemas and readers, the pure
 * resolver, and the builders of what search engines read (JSON-LD, the sitemap, the robots rules). Nothing here reads
 * the database: the renderer and the admin hand in what they have checked.
 */
export {
  absoluteHttps, applyTitleTemplate, DEFAULT_TITLE_TEMPLATE, EMPTY_ENTRY_SEO, entrySeoSchema, readEntrySeo, readSiteSeo, SEARCH_CONSOLE_TOKEN_MAX,
  SEO_CANONICAL_MAX, SEO_DESCRIPTION_ADVISED, SEO_DESCRIPTION_MAX, SEO_TITLE_ADVISED, SEO_TITLE_MAX, SITE_SEO_DEFAULTS, siteSeoSchema, TITLE_SEPARATOR,
  TITLE_TEMPLATE_MAX, TITLE_TOKENS,
} from "./settings";
export type { EntrySeo, SiteSeo } from "./settings";
export { firstWords, resolveSeo, siteUrl } from "./resolve";
export type { ResolvedSeo, RobotsReason, SeoFlags, SeoImage, SeoPage, SeoSite, SeoSource } from "./resolve";
export { documentText, robotsRules, serializeJsonLd, sitemapXml, structuredData } from "./output";
export type { Crumb, RobotsRules, SitemapUrl, StructuredDataInput } from "./output";
// M8-5 (ADR 0032): redirects' rules, shared by the services, the redirects page and the public site.
export {
  archivePath, AUTO_REDIRECT_STATUS, blogRouteOf, DEFAULT_REDIRECT_STATUS, encodeSitePath, followRedirects, isPermanent, isRedirectStatus, isSitePath,
  parseRedirectDestination, parseSitePath, planRedirectWrite, REDIRECT_DEPTH_MAX, REDIRECT_PATH_MAX, REDIRECT_REFUSALS, REDIRECT_SEGMENTS_MAX, REDIRECT_STATUS_LABELS,
  REDIRECT_STATUSES, REDIRECT_URL_MAX, REDIRECTS_MAX, RESERVED_REDIRECT_PATHS, responseStatusOf,
} from "./redirects";
export type { BlogRoute, ChainEnd, RedirectDestination, RedirectStatus, WritePlan } from "./redirects";
