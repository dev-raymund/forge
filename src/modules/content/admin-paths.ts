import type { ContentTypeKey } from "./types/definition";

/**
 * The content module's admin URLs (plan §19). Pure and client-safe.
 */
const SEGMENT: Readonly<Record<ContentTypeKey, string>> = { page: "pages", post: "posts" };

/** The editor of one entry: `/{org}/sites/{site}/pages/{id}` or `…/posts/{id}` (M5-4). */
export const entryEditorPath = (orgSlug: string, siteSlug: string, type: ContentTypeKey, entryId: string): string =>
  `/${orgSlug}/sites/${siteSlug}/${SEGMENT[type]}/${entryId}`;

/** The list of a type's entries: the page tree, or the posts (M5-7). */
export const entryListPath = (orgSlug: string, siteSlug: string, type: ContentTypeKey): string => `/${orgSlug}/sites/${siteSlug}/${SEGMENT[type]}`;

/** The new-entry form of a type (M5-7). Creating happens on submit, never on GET: Next prefetches links (plan §19). */
export const newEntryPath = (orgSlug: string, siteSlug: string, type: ContentTypeKey): string => `${entryListPath(orgSlug, siteSlug, type)}/new`;

/** The category or tag screen (M5-8): `/…/posts/categories`, `/…/posts/tags`. */
export const termListPath = (orgSlug: string, siteSlug: string, taxonomy: "category" | "tag"): string =>
  `${entryListPath(orgSlug, siteSlug, "post")}/${taxonomy === "category" ? "categories" : "tags"}`;

/** The internal JSON search behind the editor's link picker (M5-4). */
export const ENTRY_SEARCH_PATH = "/api/app/entries/search";
