import { tags } from "./tags";

/**
 * The one invalidation map (D-27, long-term §24.3, reduced to the V1 tag set).
 * `immediate` tags must show fresh content on the very next request;
 * `stale` tags may serve stale-while-revalidate.
 */

export type CacheEvent =
  | { type: "entry.published" | "entry.unpublished" | "entry.trashed"; siteId: string; entryId: string; contentType: string; pathChanged?: boolean }
  // A live entry's path changed without it being published again: a page below one whose path changed, or the old and new Home (M5-3).
  | { type: "entry.moved"; siteId: string; entryId: string; contentType: string }
  | { type: "site.configChanged"; siteId: string } // settings, theme, menus, redirects
  // M8-4: the site's SEO defaults: its settings, and whether the host's robots.txt lists it (discourage indexing).
  | { type: "site.seoChanged"; siteId: string }
  | { type: "site.statusChanged"; siteId: string } // coming soon ↔ live ↔ suspended, theme switch
  | { type: "domain.changed"; siteId: string; hostnames: readonly string[] }
  // Details changed (title, alt text, caption): pages drawing the image may show the old ones for one request.
  | { type: "media.updated"; mediaId: string; siteId?: string }
  // Trashed or restored (M6-3): a page drawing the image must stop (or start) at once; `/media` already refuses a
  // trashed item's objects, so a stale page would show a broken image. `siteId` reaches renders that draw more images
  // than they tag one by one (M6-4, `site:{id}:media`).
  | { type: "media.trashed" | "media.restored"; mediaId: string; siteId?: string }
  // A category or tag was created, renamed, re-slugged, moved or deleted (M5-8): where archives resolve (routes), the
  // published posts that show it (their entries: names and links), and the lists.
  | { type: "term.changed"; siteId: string; entryIds: readonly string[] };

/** Past this many posts carrying a term, a term change flushes the whole site (`site:{id}`) instead of each post. */
export const TERM_ENTRY_TAGS_MAX = 200;

export type TagSet = { immediate: string[]; stale: string[] };

export function tagsFor(event: CacheEvent): TagSet {
  switch (event.type) {
    case "entry.published":
      return {
        // An auto-redirect on a path change lives in the site's config.
        immediate: [
          tags.entry(event.siteId, event.entryId),
          tags.routes(event.siteId),
          ...(event.pathChanged ? [tags.config(event.siteId)] : []),
        ],
        stale: [tags.list(event.siteId, event.contentType)],
      };
    case "entry.unpublished":
    case "entry.trashed":
      // Gone from the site (M7-1): its page, its path, and the lists and archives that link to it, at once. A list
      // that showed it for one more request would send a visitor to a page that is no longer there.
      return {
        immediate: [
          tags.entry(event.siteId, event.entryId),
          tags.routes(event.siteId),
          tags.list(event.siteId, event.contentType),
          ...(event.pathChanged ? [tags.config(event.siteId)] : []),
        ],
        stale: [],
      };
    case "entry.moved":
      // As a publish that changed the path: its own page, the routes, the config (for M8-5's redirect), its lists.
      return {
        immediate: [tags.entry(event.siteId, event.entryId), tags.routes(event.siteId), tags.config(event.siteId)],
        stale: [tags.list(event.siteId, event.contentType)],
      };
    case "site.configChanged":
      return { immediate: [tags.config(event.siteId)], stale: [] };
    case "site.seoChanged":
      return { immediate: [tags.config(event.siteId), tags.robots()], stale: [] };
    // A site going live or back (or its address changing) is listed in, or left out of, the host's robots.txt (M8-4).
    // A theme change (M4-4) sends this event too, to flush the whole site: the robots list is then read once more.
    case "site.statusChanged":
      return { immediate: [tags.site(event.siteId), tags.robots()], stale: [] };
    case "domain.changed":
      return { immediate: [...event.hostnames.map(tags.host), tags.site(event.siteId), tags.robots()], stale: [] };
    case "media.updated":
      return { immediate: [], stale: [tags.media(event.mediaId), ...(event.siteId ? [tags.siteMedia(event.siteId)] : [])] };
    case "media.trashed":
    case "media.restored":
      return { immediate: [tags.media(event.mediaId), ...(event.siteId ? [tags.siteMedia(event.siteId)] : [])], stale: [] };
    case "term.changed":
      return {
        immediate: [
          tags.routes(event.siteId),
          ...(event.entryIds.length > TERM_ENTRY_TAGS_MAX ? [tags.site(event.siteId)] : event.entryIds.map((entryId) => tags.entry(event.siteId, entryId))),
        ],
        // As a publish does (D-27): lists may be stale for one request.
        stale: [tags.list(event.siteId, "post")],
      };
  }
}

/** Union over several events; a tag that is immediate anywhere is never also stale. */
export function tagsForAll(events: CacheEvent[]): TagSet {
  const immediate = new Set<string>();
  const stale = new Set<string>();
  for (const event of events) {
    const set = tagsFor(event);
    set.immediate.forEach((t) => immediate.add(t));
    set.stale.forEach((t) => stale.add(t));
  }
  immediate.forEach((t) => stale.delete(t));
  return { immediate: [...immediate], stale: [...stale] };
}
