/** Public cache API (D-27): tags for `cacheTag()`, the event map, invalidation, the profile. */
export { tags } from "./tags";
export { tagsFor, tagsForAll } from "./events";
export type { CacheEvent, TagSet } from "./events";
export { invalidate } from "./invalidate";
export type { InvalidationMode } from "./invalidate";

/**
 * The `cacheLife` profile for public CMS data (defined in next.config.ts).
 * Content changes are pushed by tags, so time-based expiry is only a
 * self-healing bound for a missed invalidation (ADR 0002).
 */
export const CMS_CACHE_PROFILE = "cms";
export const CMS_CACHE_LIFE = {
  stale: 300, // client router cache: 5 minutes
  revalidate: 86_400, // background refresh at most daily (self-healing bound, §24.4)
  expire: 604_800, // after a week without traffic, the next request waits for fresh data
} as const;
