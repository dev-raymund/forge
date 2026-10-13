/**
 * Client-safe exports of the content module (M5-2): the content-type registry,
 * paths and slugs. Pure; the editor (M5-4) and the renderer (M5-6) read the
 * same definitions as the services.
 */
export { CONTENT_TYPE_KEYS, CONTENT_TYPES, contentType, isContentTypeKey } from "./types/registry";
export type { ContentTypeDefinition, ContentTypeKey, RoutingInput, Taxonomy } from "./types/definition";
export {
  HOME_PATH, isEntryPath, pagePath, parentDir, ParentChainError, parentChain, pathFromChain, pathUnder, postPath, RESERVED_PATHS, reservedPathReason, wouldCreateCycle,
} from "./paths";
export type { PageNode } from "./paths";
export { ENTRY_SLUG_MAX, FALLBACK_SLUG, isEntrySlug, nextFreeSlug, slugFromTitle, slugWithSuffix } from "./slugs";
// M5-3: the stored document (plan §6.2) and what the entry forms accept. The editor (M5-4) checks the same before saving.
export { canonicalJson, documentProblem, emptyDocument, parseDocument } from "./document/parse";
export type { ParseResult } from "./document/parse";
export { DOCUMENT_VERSION, isSafeHref, MAX_DOCUMENT_BYTES, MAX_NODES, storedDocumentSchema } from "./document/schema";
// M5-6: what a document points at, for the public renderer's `entry:` links.
export { referencesOf } from "./document/references";
export type { DocumentReferences } from "./document/references";
export type { StoredDocument } from "./document/schema";
export {
  createEntrySchema, draftSchema, ENTRY_EXCERPT_MAX, ENTRY_TERMS_MAX, ENTRY_TITLE_MAX, typedSlug, versionSchema,
} from "./validation";
export type { CreateEntryInput, DraftInput } from "./validation";
// M5-4: what the editor recognises, and where it lives.
export { DRAFT_CHANGED, NEWER_SAVE } from "./messages";
export { ENTRY_SEARCH_PATH, entryEditorPath, entryListPath, newEntryPath, termListPath } from "./admin-paths";
// M5-7: the lists' queries, read from their URLs.
export {
  ENTRY_STATUS_FILTERS, hasListFilters, LIST_SEARCH_MAX, listHref, parsePageQuery, parsePostQuery, POST_SORTS, POSTS_PAGE_SIZE,
} from "./list-query";
export type { EntryStatusFilter, PageListQuery, PostListQuery, PostSort } from "./list-query";
