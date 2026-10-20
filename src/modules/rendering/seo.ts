import "server-only";
import type { Metadata } from "next";
import { contentType } from "@/modules/content/shared";
import type { PublicImage } from "@/modules/media/public";
import { documentText, resolveSeo, siteUrl, structuredData, type Crumb, type ResolvedSeo, type SeoImage, type SeoPage, type SitemapUrl } from "@/modules/seo/shared";
import { env, resolveSearchIndexing } from "@/platform/config/env";
import { siteBasePath, type SiteLocator } from "@/platform/routing/hosts";
import { liveTitlesAt, type SitemapRows } from "./content";
import type { PublicPage } from "./public-page";
import type { PublicSite } from "./queries";
import { listPageHref } from "./routes";

/**
 * A public page's SEO (M8-4; plan §10; ADR 0031): what the resolver is handed, from what the renderer has already
 * read and checked (the published revision, the site's settings, usable images only), and what comes out of it: the
 * page's metadata and its structured data. Nothing here reads a request's headers: addresses are built from the
 * deployment's own origin (`APP_ORIGIN`) and the site's base (`/s/{address}` in V1).
 */

/** Whether this deployment lets search engines index its sites (`SEARCH_INDEXING`; only Vercel production by default). */
export const searchIndexingAllowed = (): boolean => resolveSearchIndexing(env("core"));

/** The site's public address, absolute: `https://cms.example.com/s/acme`. */
export const siteBaseUrl = (locator: SiteLocator): string => `${env("core").APP_ORIGIN.replace(/\/$/, "")}${siteBasePath(locator)}`;

/** An image as search engines and social sites get it: its widest stored width (never the original), with its alt text. */
export function seoImage(image: PublicImage | null | undefined): SeoImage | null {
  const widest = image?.sources.reduce<PublicImage["sources"][number] | null>((best, source) => (!best || source.width > best.width ? source : best), null);
  return image && widest ? { url: widest.url, width: widest.width, height: widest.height, alt: image.alt } : null;
}

/** Where the page is on the site, and what it is, for the resolver. */
export function seoPageOf(page: PublicPage, site: PublicSite): SeoPage {
  const blog = `/${site.reading.blogPath}`;
  switch (page.kind) {
    case "site-home":
      return { kind: "site-home", path: "/", title: site.name, isHome: true };
    case "entry": {
      const { entry } = page;
      return {
        kind: "entry", path: entry.path, title: entry.title || "Untitled", isHome: entry.path === "/", contentType: entry.type,
        typeTitleTemplate: contentType(entry.type)?.seoDefaults.titleTemplate,
        excerpt: entry.excerpt, bodyText: documentText(entry.content), featuredImage: seoImage(entry.featuredImage),
        entrySeo: entry.seo, entryOgImage: seoImage(entry.ogImage), publishedAt: entry.publishedAt, modifiedAt: entry.modifiedAt,
      };
    }
    case "blog-index":
      return { kind: "blog-index", path: listPageHref(blog, page.page), title: "Blog", pageNumber: page.page, isHome: false };
    case "term-archive":
      return {
        kind: "term-archive", path: listPageHref(`${blog}/${page.taxonomy}/${page.term.slug}`, page.page), title: page.term.name, pageNumber: page.page,
        termDescription: page.term.description, isHome: false,
      };
  }
}

/** A live page's resolved SEO. A preview passes `preview`: never indexed, whatever the rest says. */
export function publicPageSeo(site: PublicSite, locator: SiteLocator, page: PublicPage, options: { preview?: boolean } = {}): ResolvedSeo {
  return resolveSeo({
    site: {
      name: site.name, tagline: site.tagline, baseUrl: siteBaseUrl(locator), seo: site.seo, defaultOgImage: seoImage(site.defaultOgImage),
      status: site.status === "live" ? "live" : "coming_soon",
    },
    page: seoPageOf(page, site),
    flags: { preview: options.preview ?? false, indexingAllowed: searchIndexingAllowed() },
  });
}

/** The resolved SEO as Next writes it into the page's head: title, description, canonical, robots, Open Graph, Twitter, verification. */
export function seoMetadata(resolved: ResolvedSeo, site: PublicSite): Metadata {
  const image = resolved.image.value;
  return {
    title: { absolute: resolved.title.value },
    ...(resolved.description.value ? { description: resolved.description.value } : {}),
    alternates: { canonical: resolved.canonical.value },
    robots: { index: resolved.robots.index, follow: resolved.robots.follow },
    openGraph: {
      type: resolved.openGraph.type,
      title: resolved.openGraph.title,
      ...(resolved.openGraph.description ? { description: resolved.openGraph.description } : {}),
      url: resolved.openGraph.url,
      siteName: resolved.openGraph.siteName,
      locale: site.language.replace("-", "_"),
      ...(image ? { images: [{ url: image.url, width: image.width, height: image.height, alt: image.alt }] } : {}),
    },
    twitter: {
      card: resolved.twitter.card,
      title: resolved.twitter.title,
      ...(resolved.twitter.description ? { description: resolved.twitter.description } : {}),
      ...(image ? { images: [{ url: image.url, alt: image.alt }] } : {}),
    },
    ...(resolved.verification ? { verification: { google: resolved.verification.google } } : {}),
  };
}

/**
 * The page's structured data: the site, its publisher, the page, and its breadcrumbs (the site's home; for a page its
 * live ancestors by path; for a post or an archive, the blog). Titles are the published ones.
 */
export async function publicStructuredData(site: PublicSite, locator: SiteLocator, page: PublicPage, resolved: ResolvedSeo) {
  const base = siteBaseUrl(locator);
  const blogPath = `/${site.reading.blogPath}`;
  const home: Crumb = { name: site.name, url: base };
  const blog: Crumb = { name: "Blog", url: siteUrl(base, blogPath) };
  const seoPage = seoPageOf(page, site);
  let crumbs: Crumb[] = [home];
  let kind: "page" | "post" | "list" | "home" = "home";
  if (page.kind === "entry" && page.entry.path !== "/") {
    if (page.entry.type === "post") {
      kind = "post";
      crumbs = [home, blog, { name: seoPage.title, url: siteUrl(base, page.entry.path) }];
    } else {
      kind = "page";
      const segments = page.entry.path.split("/").filter(Boolean);
      const ancestors = segments.slice(0, -1).map((_, index) => `/${segments.slice(0, index + 1).join("/")}`);
      const titles = ancestors.length ? await liveTitlesAt(site.orgId, site.id, site.language, ancestors) : {};
      crumbs = [home, ...ancestors.filter((path) => titles[path]).map((path) => ({ name: titles[path]!, url: siteUrl(base, path) })), { name: seoPage.title, url: siteUrl(base, page.entry.path) }];
    }
  } else if (page.kind === "blog-index") {
    kind = "list";
    crumbs = [home, blog];
  } else if (page.kind === "term-archive") {
    kind = "list";
    crumbs = [home, blog, { name: page.term.name, url: siteUrl(base, `${blogPath}/${page.taxonomy}/${page.term.slug}`) }];
  }
  return structuredData({
    site: { name: site.name, baseUrl: base, language: site.language, logo: site.imagery.logo },
    page: {
      kind, url: resolved.canonical.value, title: seoPage.title, description: resolved.description.value, image: resolved.image.value,
      publishedAt: seoPage.publishedAt ?? null, modifiedAt: seoPage.modifiedAt ?? null, breadcrumbs: crumbs,
    },
  });
}

/**
 * A site's sitemap addresses (M8-4): its home (the Home page, or the site's own home while it has none); every other
 * live entry that is indexable and its own canonical (an entry that names another canonical is a copy, and an entry
 * marked `noindex` is not listed); the blog when it has posts; each category and tag with live posts. Page 1 of each
 * list only.
 */
export function sitemapUrlsOf(rows: SitemapRows, base: string, blogPath: string): SitemapUrl[] {
  const own = (path: string, canonical: string) => !canonical || canonical === siteUrl(base, path);
  const listed = rows.entries.filter((entry) => !entry.noindex && own(entry.path, entry.canonical));
  const homeEntry = rows.entries.find((entry) => entry.path === "/");
  const urls: SitemapUrl[] = [];
  if (!homeEntry || listed.includes(homeEntry)) urls.push({ loc: base, lastmod: homeEntry?.lastmod ?? null });
  for (const entry of listed) if (entry.path !== "/") urls.push({ loc: siteUrl(base, entry.path), lastmod: entry.lastmod });
  const posts = rows.entries.filter((entry) => entry.type === "post");
  if (posts.length) {
    const latest = posts.map((post) => post.lastmod ?? "").sort().at(-1) || null;
    urls.push({ loc: siteUrl(base, `/${blogPath}`), lastmod: latest });
  }
  for (const term of rows.terms) urls.push({ loc: siteUrl(base, `/${blogPath}/${term.taxonomy}/${term.slug}`) });
  return urls;
}

/** What a sitemap address answers when the site has none to give: a plain 404, never indexed. */
export const indexableNotice = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" } });
