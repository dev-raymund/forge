import "server-only";
import { cache } from "react";
import { referencesOf } from "@/modules/content/shared";
import { livePaths, loadEntry, loadPostList, resolveRoute, type PostSummary, type PublicTerm, type PublishedEntry, type Taxonomy } from "./content";
import type { PublicSite } from "./queries";

/**
 * What a live site shows at a path (M5-6): the route, and the data its template needs, or null when the path names
 * nothing (the page then answers 404 with the theme's not-found template). Per request (`cache`): the page and its
 * metadata share one lookup, on top of the cached reads in ./content.ts.
 */

export type ListPage = { page: number; pages: number; posts: PostSummary[] };

export type PublicPage =
  /** `/` while the site has no published Home page: its name and tagline (M4-3's live home). */
  | { kind: "site-home" }
  /** A published page or post. `links` maps the live entries its `entry:` links name to their paths. */
  | { kind: "entry"; entry: PublishedEntry; links: Record<string, string> }
  | ({ kind: "blog-index" } & ListPage)
  | ({ kind: "term-archive"; taxonomy: Taxonomy; term: PublicTerm } & ListPage);

const pagesOf = (total: number, perPage: number) => Math.max(1, Math.ceil(total / perPage));

/**
 * The URL's segments as Next decoded them, kept apart: joining them would let `about%2Fteam` (one segment holding a
 * slash) pass for `/about/team`, a second spelling of that page. `routeFor` refuses such a segment.
 */
export const publicPageFor = (site: PublicSite, segments: readonly string[]): Promise<PublicPage | null> => pageFor(site, JSON.stringify(segments));

// `cache` compares arguments by identity: the segments travel as one string, so the page and its metadata share a lookup.
const pageFor = cache(async (site: PublicSite, key: string): Promise<PublicPage | null> => {
  const segments = JSON.parse(key) as string[];
  const { blogPath, postsPerPage } = site.reading;
  const route = await resolveRoute(site.orgId, site.id, site.language, blogPath, segments);
  if (!route) return null;
  switch (route.kind) {
    case "site-home":
      return route;
    case "entry": {
      const entry = await loadEntry(site.orgId, site.id, route.entryId);
      if (!entry) return null;
      const linked = [...referencesOf(entry.content).entryIds].sort();
      return { kind: "entry", entry, links: await livePaths(site.orgId, site.id, site.language, linked) };
    }
    case "blog-index":
    case "term-archive": {
      const termId = route.kind === "term-archive" ? route.termId : null;
      const { posts, total } = await loadPostList(site.orgId, site.id, site.language, route.page, postsPerPage, termId);
      const pages = pagesOf(total, postsPerPage);
      if (route.page > pages) return null; // past the last page: not found, like any other missing page
      return route.kind === "blog-index"
        ? { kind: "blog-index", page: route.page, pages, posts }
        : { kind: "term-archive", taxonomy: route.taxonomy, term: route.term, page: route.page, pages, posts };
    }
  }
});
