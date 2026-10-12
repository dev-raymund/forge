import { uuidv7 } from "uuidv7";

/**
 * Block ids must be unique in a document (plan §6.2), and the server refuses
 * a document with two equal ones. The editor's UniqueID re-ids pasted copies,
 * but a programmatic insert can still duplicate one (ADR 0003 gap 3): give
 * every repeat a new id before saving, so such a bug cannot stall autosave.
 * The first node with an id keeps it. Returns a copy; the input is not changed.
 */
export function dedupeIds<T>(document: T, newId: () => string = uuidv7): { document: T; changed: boolean } {
  const seen = new Set<string>();
  let changed = false;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const node = { ...(value as Record<string, unknown>) };
    const attrs = node.attrs as Record<string, unknown> | undefined;
    if (attrs && typeof attrs.id === "string") {
      if (seen.has(attrs.id)) {
        node.attrs = { ...attrs, id: newId() };
        changed = true;
      } else seen.add(attrs.id);
    }
    if (Array.isArray(node.content)) node.content = node.content.map(walk);
    if (node.doc) node.doc = walk(node.doc);
    return node;
  };
  return { document: walk(document) as T, changed };
}
