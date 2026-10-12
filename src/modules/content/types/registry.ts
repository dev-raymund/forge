import type { ContentTypeDefinition, ContentTypeKey } from "./definition";
import { page } from "./page";
import { post } from "./post";

/**
 * The content types (plan §5): the one list. Adding a type is a definition
 * here, a migration widening `entries_type_check`, its permission keys and a
 * theme template; nothing else changes.
 *
 * A key is compared with each entry's `key`; it is never used as a property
 * name or a module path, so an unknown key (`__proto__`, `Page`, `product`)
 * finds nothing, as with themes (ADR 0012).
 */
export const CONTENT_TYPES: readonly ContentTypeDefinition[] = [page, post];

export const CONTENT_TYPE_KEYS: readonly ContentTypeKey[] = CONTENT_TYPES.map((type) => type.key);

export const isContentTypeKey = (key: unknown): key is ContentTypeKey => typeof key === "string" && CONTENT_TYPE_KEYS.includes(key as ContentTypeKey);

/** The definition of a type, or null for anything that is not one of the registry's keys. */
export function contentType(key: unknown): ContentTypeDefinition | null {
  return CONTENT_TYPES.find((type) => type.key === key) ?? null;
}
