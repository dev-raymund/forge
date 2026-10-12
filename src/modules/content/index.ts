import "server-only";

/**
 * Public server API of the content module. M5-2: the content-type registry,
 * paths, slugs, and inserting an entry under a free slug. The entry services
 * (create, save, publish) and their Server Actions are M5-3's.
 */
export * from "./shared";
export { ENTRY_PATH_KEY, insertWithUniqueSlug, MAX_SLUG_ATTEMPTS, SLUG_RACE_LOST } from "./unique-slug";
export type { SlugPlace } from "./unique-slug";
