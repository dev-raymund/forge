import { permissionsForRole } from "@/modules/tenancy/shared";

/**
 * Who may see an entry, asked of a role read just now (M7-4), for code that has no request context: the preview
 * renderer, which serves a page to whoever holds a preview token and must ask whether the person it names may still see
 * the entry. The same rule as `canSeeEntry` (./policies.ts), from the same catalog, and tested to agree with it:
 *
 *   pages   entries.page.read, unless the role writes only its own posts (an Author sees no pages)
 *   posts   entries.post.read; a role that writes only its own posts sees only its own
 *
 * Pure and client-safe.
 */
export function roleMaySeeEntry(role: string, userId: string, entry: { type: "page" | "post"; authorId: string | null }): boolean {
  const held = permissionsForRole(role);
  const ownPostsOnly = held.has("entries.post.update.own") && !held.has("entries.post.update.any") && !held.has("entries.page.update");
  if (entry.type === "page") return held.has("entries.page.read") && !ownPostsOnly;
  return held.has("entries.post.read") && (!ownPostsOnly || entry.authorId === userId);
}
