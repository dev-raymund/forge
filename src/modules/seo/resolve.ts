import { applyTitleTemplate, DEFAULT_TITLE_TEMPLATE, EMPTY_ENTRY_SEO, SEO_DESCRIPTION_ADVISED, TITLE_SEPARATOR, type EntrySeo, type SiteSeo } from "./settings";

/**
 * `resolveSeo()` (M8-4; plan §10; cms-architecture §17, D-19): what one public page says to search engines and to the
 * sites that link to it, field by field. Pure: the same input always gives the same output, and nothing is read here.
 *
 * Each field is resolved on its own, in this order, and says where its value came from (the editor's "inherited
 * from…" hints):
 *
 *   entry      the entry's own SEO (its published revision's)
 *   derived    from the content: the page's title, its excerpt or text, a category's description, a post's featured image
 *   type       the content type's defaults (`seoDefaults.titleTemplate`)
 *   site       the site's SEO defaults (`/…/seo`)
 *   platform   Forge's: `%title% · %site%`, the site's name for its home, its tagline, index and follow
 *
 * Safety overrides are applied last and always win: `noindex` (and `nofollow`) for a site that is not live yet, for a
 * preview, for a deployment that is not production, and `noindex` for a site that asks not to be indexed.
 */

export type SeoSource = "entry" | "derived" | "type" | "site" | "platform";
export type SeoImage = { url: string; width: number; height: number; alt: string };

export type SeoPage = {
  /** What kind of page: an entry (page or post), the site's own home (no Home page published), a list. */
  kind: "entry" | "site-home" | "blog-index" | "term-archive";
  /** The URL path under the site's base (`/`, `/about/team`, `/blog/page/2`). */
  path: string;
  /** The page's own title: the entry's published title, "Blog", the term's name. */
  title: string;
  /** An entry at `/` (the Home page) or the site's own home. */
  isHome: boolean;
  /** A list's page, from 1. */
  pageNumber?: number;
  contentType?: "page" | "post";
  /** The content type's title template, if it has one. */
  typeTitleTemplate?: string;
  /** Derived descriptions: a post's excerpt, the first words of its text, a term's description. */
  excerpt?: string;
  bodyText?: string;
  termDescription?: string;
  /** Derived image: a post's featured image (usable, resolved). */
  featuredImage?: SeoImage | null;
  /** The entry's own SEO, and its own social image (usable, resolved: an unusable one is null). */
  entrySeo?: EntrySeo;
  entryOgImage?: SeoImage | null;
  /** When it was first published, and when this version was. */
  publishedAt?: string | null;
  modifiedAt?: string | null;
};

export type SeoSite = {
  name: string;
  tagline: string;
  /** The site's public address, absolute and without a trailing slash: `https://cms.example.com/s/acme`. */
  baseUrl: string;
  seo: SiteSeo;
  /** The site's default social image (usable, resolved), and its logo. */
  defaultOgImage?: SeoImage | null;
  status: "live" | "coming_soon";
};

export type SeoFlags = { preview: boolean; indexingAllowed: boolean };

export type RobotsReason = "entry" | "site" | "coming-soon" | "preview" | "non-production";
export type ResolvedSeo = {
  title: { value: string; source: SeoSource };
  description: { value: string; source: SeoSource | null };
  canonical: { value: string; source: SeoSource };
  robots: { index: boolean; follow: boolean; reasons: RobotsReason[] };
  image: { value: SeoImage | null; source: SeoSource | null };
  openGraph: { type: "website" | "article"; title: string; description: string; url: string; siteName: string; image: SeoImage | null };
  twitter: { card: "summary_large_image" | "summary"; title: string; description: string; image: SeoImage | null };
  verification: { google: string } | null;
};

/** A page's URL: its path under the site's base. `/` is the base itself. */
export const siteUrl = (baseUrl: string, path: string) => (path === "/" ? baseUrl : `${baseUrl}${path}`);

/** The first words of a text, at most `max` characters, cut at a word and marked as cut. */
export function firstWords(text: string, max = SEO_DESCRIPTION_ADVISED): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > max * 0.6 ? cut.slice(0, atWord) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}

export function resolveSeo(input: { site: SeoSite; page: SeoPage; flags: SeoFlags }): ResolvedSeo {
  const { site, page, flags } = input;
  const own = page.entrySeo ?? EMPTY_ENTRY_SEO;

  // Title: the entry's own, as it is; otherwise the page's title through a template (the site's name alone for its home).
  const listTitle = page.pageNumber && page.pageNumber > 1 ? `${page.title} ${TITLE_SEPARATOR} Page ${page.pageNumber}` : page.title;
  const title: ResolvedSeo["title"] = own.title
    ? { value: own.title, source: "entry" }
    : page.isHome
      ? { value: site.name, source: "platform" }
      : page.typeTitleTemplate
        ? { value: applyTitleTemplate(page.typeTitleTemplate, { title: listTitle, site: site.name }), source: "type" }
        : site.seo.titleTemplate !== DEFAULT_TITLE_TEMPLATE
          ? { value: applyTitleTemplate(site.seo.titleTemplate, { title: listTitle, site: site.name }), source: "site" }
          : { value: applyTitleTemplate(DEFAULT_TITLE_TEMPLATE, { title: listTitle, site: site.name }), source: "platform" };

  // Description: the entry's own; derived (excerpt, then the text, then a term's description); the site's default; for
  // the home, its tagline.
  const derived = page.excerpt?.trim() || (page.bodyText ? firstWords(page.bodyText) : "") || page.termDescription?.trim() || "";
  const description: ResolvedSeo["description"] = own.description
    ? { value: own.description, source: "entry" }
    : derived
      ? { value: firstWords(derived, 320), source: "derived" }
      : site.seo.defaultDescription
        ? { value: site.seo.defaultDescription, source: "site" }
        : page.isHome && site.tagline.trim()
          ? { value: site.tagline.trim(), source: "platform" }
          : { value: "", source: null };

  // Canonical: the entry's own (an absolute https address), otherwise the page's own address on the site.
  const canonical: ResolvedSeo["canonical"] = own.canonical ? { value: own.canonical, source: "entry" } : { value: siteUrl(site.baseUrl, page.path), source: "derived" };

  // Social image: the entry's own, a post's featured image, the site's default.
  const image: ResolvedSeo["image"] = page.entryOgImage
    ? { value: page.entryOgImage, source: "entry" }
    : page.featuredImage
      ? { value: page.featuredImage, source: "derived" }
      : site.defaultOgImage
        ? { value: site.defaultOgImage, source: "site" }
        : { value: null, source: null };

  // Robots: the entry's own choices, then the safety overrides, which always win.
  const reasons: RobotsReason[] = [];
  let index = !own.noindex;
  let follow = !own.nofollow;
  if (own.noindex || own.nofollow) reasons.push("entry");
  if (site.seo.discourageIndexing) {
    index = false;
    reasons.push("site");
  }
  if (site.status !== "live") {
    index = follow = false;
    reasons.push("coming-soon");
  }
  if (flags.preview) {
    index = follow = false;
    reasons.push("preview");
  }
  if (!flags.indexingAllowed) {
    index = false;
    reasons.push("non-production");
  }

  const isArticle = page.kind === "entry" && page.contentType === "post";
  return {
    title,
    description,
    canonical,
    robots: { index, follow, reasons },
    image,
    openGraph: { type: isArticle ? "article" : "website", title: title.value, description: description.value, url: canonical.value, siteName: site.name, image: image.value },
    twitter: { card: image.value ? "summary_large_image" : "summary", title: title.value, description: description.value, image: image.value },
    verification: site.seo.searchConsoleToken ? { google: site.seo.searchConsoleToken } : null,
  };
}
