import { tags } from "./tags";

/**
 * The one invalidation map (D-27, long-term §24.3, reduced to the V1 tag set).
 * `immediate` tags must show fresh content on the very next request;
 * `stale` tags may serve stale-while-revalidate.
 */

export type CacheEvent =
  | { type: "entry.published" | "entry.unpublished" | "entry.trashed"; siteId: string; entryId: string; contentType: string; pathChanged?: boolean }
  | { type: "site.configChanged"; siteId: string } // settings, theme, menus, redirects
  | { type: "site.statusChanged"; siteId: string } // coming soon ↔ live ↔ suspended, theme switch
  | { type: "domain.changed"; siteId: string; hostnames: readonly string[] }
  | { type: "media.updated"; mediaId: string };

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
    case "site.configChanged":
      return { immediate: [tags.config(event.siteId)], stale: [] };
    case "site.statusChanged":
      return { immediate: [tags.site(event.siteId)], stale: [] };
    case "domain.changed":
      return { immediate: [...event.hostnames.map(tags.host), tags.site(event.siteId)], stale: [] };
    case "media.updated":
      return { immediate: [], stale: [tags.media(event.mediaId)] };
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
