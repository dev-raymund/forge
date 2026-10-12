import type { ContentTypeKey } from "./types/definition";

/**
 * The content module's admin URLs (plan §19). Pure and client-safe. The
 * entry lists and new-entry forms (`/…/pages`, `/…/posts`, `…/new`) are M5-7's.
 */
const SEGMENT: Readonly<Record<ContentTypeKey, string>> = { page: "pages", post: "posts" };

/** The editor of one entry: `/{org}/sites/{site}/pages/{id}` or `…/posts/{id}` (M5-4). */
export const entryEditorPath = (orgSlug: string, siteSlug: string, type: ContentTypeKey, entryId: string): string =>
  `/${orgSlug}/sites/${siteSlug}/${SEGMENT[type]}/${entryId}`;

/** The internal JSON search behind the editor's link picker (M5-4). */
export const ENTRY_SEARCH_PATH = "/api/app/entries/search";
