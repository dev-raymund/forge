import "server-only";
import { revalidateTag, updateTag } from "next/cache";
import { tagsForAll, type CacheEvent } from "./events";

/**
 * Flush cache tags after a committed change (D-27).
 *
 * - `"action"` (Server Actions): `updateTag` gives read-your-writes: the
 *   author's next request, and everyone's, sees fresh content.
 * - `"background"` (route handlers, jobs): `updateTag` is not allowed there,
 *   so immediate tags use `revalidateTag(tag, { expire: 0 })`.
 * - Stale tags always use `revalidateTag(tag, "max")` (stale-while-revalidate).
 *
 * Idempotent: replaying it is always safe.
 */
export type InvalidationMode = "action" | "background";

export function invalidate(events: CacheEvent[], mode: InvalidationMode): { immediate: string[]; stale: string[] } {
  const set = tagsForAll(events);
  for (const tag of set.immediate) {
    if (mode === "action") updateTag(tag);
    else revalidateTag(tag, { expire: 0 });
  }
  for (const tag of set.stale) revalidateTag(tag, "max");
  return set;
}
