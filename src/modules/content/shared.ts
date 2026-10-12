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
export type { StoredDocument } from "./document/schema";
export {
  createEntrySchema, draftSchema, ENTRY_EXCERPT_MAX, ENTRY_TERMS_MAX, ENTRY_TITLE_MAX, typedSlug, versionSchema,
} from "./validation";
export type { CreateEntryInput, DraftInput } from "./validation";
