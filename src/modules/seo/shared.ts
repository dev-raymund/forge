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
