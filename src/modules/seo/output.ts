import type { SeoImage } from "./resolve";

/**
 * What a site says in machine-readable form (M8-4; plan §10; ADR 0031): its pages' structured data (JSON-LD), its
 * sitemap, the host's robots rules, and the plain text of a document. Pure and client-safe: built from values the
 * renderer has already checked, and serialised here, never from stored HTML.
 */

// ── JSON-LD ───────────────────────────────────────────────────────────────────

export type Crumb = { name: string; url: string };
export type StructuredDataInput = {
  site: { name: string; baseUrl: string; language: string; logo: { url: string; width: number; height: number } | null };
  page: {
    kind: "page" | "post" | "list" | "home";
    url: string;
    title: string;
    description: string;
    image: SeoImage | null;
    publishedAt: string | null;
    modifiedAt: string | null;
    /** From the site's home to this page, both included. One crumb (the home) draws no `BreadcrumbList`. */
    breadcrumbs: Crumb[];
  };
};

/**
 * One `@graph`: the site (`WebSite`), who publishes it (`Organization`: its name, address and logo, nothing more is
 * known), the page (`BlogPosting` for a post, `WebPage` otherwise) and where it is (`BreadcrumbList`). Only what the
 * site holds: no author, rating or address it does not have.
 */
export function structuredData({ site, page }: StructuredDataInput) {
  const websiteId = `${site.baseUrl}#website`;
  const organizationId = `${site.baseUrl}#organization`;
  const graph: Record<string, unknown>[] = [
    { "@type": "WebSite", "@id": websiteId, url: site.baseUrl, name: site.name, inLanguage: site.language, publisher: { "@id": organizationId } },
    {
      "@type": "Organization",
      "@id": organizationId,
      name: site.name,
      url: site.baseUrl,
      ...(site.logo ? { logo: { "@type": "ImageObject", url: site.logo.url, width: site.logo.width, height: site.logo.height } } : {}),
    },
  ];
  const image = page.image ? { "@type": "ImageObject", url: page.image.url, width: page.image.width, height: page.image.height } : undefined;
  const crumbs = page.breadcrumbs.length > 1;
  const breadcrumbId = `${page.url}#breadcrumb`;
  if (page.kind === "post") {
    graph.push({
      "@type": "BlogPosting",
      "@id": `${page.url}#article`,
      headline: page.title.slice(0, 110),
      url: page.url,
      mainEntityOfPage: page.url,
      ...(page.description ? { description: page.description } : {}),
      ...(image ? { image } : {}),
      ...(page.publishedAt ? { datePublished: page.publishedAt } : {}),
      ...(page.modifiedAt ? { dateModified: page.modifiedAt } : {}),
      publisher: { "@id": organizationId },
      isPartOf: { "@id": websiteId },
      inLanguage: site.language,
      ...(crumbs ? { breadcrumb: { "@id": breadcrumbId } } : {}),
    });
  } else {
    graph.push({
      "@type": "WebPage",
      "@id": `${page.url}#webpage`,
      url: page.url,
      name: page.title,
      ...(page.description ? { description: page.description } : {}),
      ...(image ? { primaryImageOfPage: image } : {}),
      isPartOf: { "@id": websiteId },
      inLanguage: site.language,
      ...(crumbs ? { breadcrumb: { "@id": breadcrumbId } } : {}),
    });
  }
  if (crumbs) {
    graph.push({
      "@type": "BreadcrumbList",
      "@id": breadcrumbId,
      itemListElement: page.breadcrumbs.map((crumb, index) => ({ "@type": "ListItem", position: index + 1, name: crumb.name, item: crumb.url })),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

/**
 * JSON for a `<script type="application/ld+json">`: `<`, `>` and `&` written as `\u003c`, `\u003e` and `\u0026`, and the
 * two line separators JavaScript treats as line ends escaped too, so no value can close the script or open a tag.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ── Sitemap ───────────────────────────────────────────────────────────────────

export type SitemapUrl = { loc: string; lastmod?: string | null };

const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A sitemap (sitemaps.org 0.9): one `<url>` per address, its `lastmod` a date. Every value escaped. */
export function sitemapXml(urls: readonly SitemapUrl[]): string {
  const body = urls
    .map((url) => `  <url>\n    <loc>${xmlEscape(url.loc)}</loc>${url.lastmod ? `\n    <lastmod>${xmlEscape(url.lastmod.slice(0, 10))}</lastmod>` : ""}\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}${body ? "\n" : ""}</urlset>\n`;
}

// ── robots.txt ────────────────────────────────────────────────────────────────

export type RobotsRules = { rules: { userAgent: string; allow?: string[]; disallow: string[] }[]; sitemap?: string[] };

/**
 * The app host's robots rules in path mode (V1, ADR 0006): sites live under `/s/`, which crawlers may read; the API
 * and previews are disallowed; each live site that allows indexing lists its sitemap. A deployment that is not
 * production disallows everything and lists nothing.
 */
export function robotsRules(input: { indexingAllowed: boolean; origin: string; addresses: readonly string[] }): RobotsRules {
  if (!input.indexingAllowed) return { rules: [{ userAgent: "*", disallow: ["/"] }] };
  const origin = input.origin.replace(/\/$/, "");
  return {
    rules: [{ userAgent: "*", allow: ["/s/", "/media/"], disallow: ["/api/", "/_forge/"] }],
    ...(input.addresses.length ? { sitemap: input.addresses.map((address) => `${origin}/s/${address}/sitemap.xml`) } : {}),
  };
}

// ── A document's text ─────────────────────────────────────────────────────────

/** The text a document shows, its blocks separated by spaces: for a description derived from the content. */
export function documentText(document: unknown, max = 2000): string {
  const parts: string[] = [];
  let length = 0;
  const walk = (node: unknown, depth: number) => {
    if (length >= max || depth > 40 || !node || typeof node !== "object") return;
    const { type, text, content } = node as { type?: unknown; text?: unknown; content?: unknown };
    if (type === "text" && typeof text === "string") {
      parts.push(text);
      length += text.length;
      return;
    }
    if (Array.isArray(content)) {
      for (const child of content) walk(child, depth + 1);
      parts.push(" ");
    }
  };
  const root = document && typeof document === "object" && "doc" in (document as object) ? (document as { doc: unknown }).doc : document;
  walk(root, 0);
  return parts.join("").replace(/\s+/g, " ").trim().slice(0, max);
}
