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
  | { type: "site.statusChanged"; siteId: string } // coming soon ↔ live ↔ suspended, theme switch
  | { type: "domain.changed"; siteId: string; hostnames: readonly string[] }
  | { type: "media.updated"; mediaId: string }
  // A category or tag was created, renamed, re-slugged, moved or deleted (M5-8): where archives resolve (routes), the
  // published posts that show it (their entries: names and links), and the lists.
  | { type: "term.changed"; siteId: string; entryIds: readonly string[] };

/** Past this many posts carrying a term, a term change flushes the whole site (`site:{id}`) instead of each post. */
export const TERM_ENTRY_TAGS_MAX = 200;

export type TagSet = { immediate: string[]; stale: string[] };

export function tagsFor(event: CacheEvent): TagSet {
  switch (event.type) {
    case "entry.published":
    case "entry.unpublished":
    case "entry.trashed":
      return {
        // An auto-redirect on a path change lives in the site's config.
        immediate: [
          tags.entry(event.siteId, event.entryId),
          tags.routes(event.siteId),
          ...(event.pathChanged ? [tags.config(event.siteId)] : []),
        ],
        stale: [tags.list(event.siteId, event.contentType)],
      };
    case "entry.moved":
      // As a publish that changed the path: its own page, the routes, the config (for M8-5's redirect), its lists.
      return {
        immediate: [tags.entry(event.siteId, event.entryId), tags.routes(event.siteId), tags.config(event.siteId)],
        stale: [tags.list(event.siteId, event.contentType)],
      };
    case "site.configChanged":
      return { immediate: [tags.config(event.siteId)], stale: [] };
    case "site.statusChanged":
      return { immediate: [tags.site(event.siteId)], stale: [] };
    case "domain.changed":
      return { immediate: [...event.hostnames.map(tags.host), tags.site(event.siteId)], stale: [] };
    case "media.updated":
      return { immediate: [], stale: [tags.media(event.mediaId)] };
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
