/**
 * Client-safe exports of the content module (M5-2): the content-type registry,
 * paths and slugs. Pure; the editor (M5-4) and the renderer (M5-6) read the
 * same definitions as the services.
 */
export { CONTENT_TYPE_KEYS, CONTENT_TYPES, contentType, isContentTypeKey } from "./types/registry";
export type { ContentTypeDefinition, ContentTypeKey, RoutingInput, Taxonomy } from "./types/definition";
export {
  HOME_PATH, isEntryPath, pagePath, ParentChainError, parentChain, pathFromChain, pathUnder, postPath, RESERVED_PATHS, reservedPathReason, wouldCreateCycle,
} from "./paths";
export type { PageNode } from "./paths";
export { ENTRY_SLUG_MAX, FALLBACK_SLUG, isEntrySlug, nextFreeSlug, slugFromTitle, slugWithSuffix } from "./slugs";
