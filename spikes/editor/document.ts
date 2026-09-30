import {
  countNodes,
  DOCUMENT_VERSION,
  MAX_DOCUMENT_BYTES,
  MAX_NODES,
  storedDocumentSchema,
  type StoredDocument,
} from "./schema";

/**
 * Load/save pipeline for block documents: size limits → per-node migration →
 * closed-schema validation. The same function runs on every save (autosave,
 * API) and on read of anything older than the current versions. Isomorphic:
 * the editor can run it client-side before saving.
 */

type Attrs = Record<string, unknown>;
export type NodeMigrations = Record<string, { v: number; migrate: Record<number, (attrs: Attrs) => Attrs> }>;

/**
 * Registry of versioned custom nodes: `v` is the current attrs version and
 * `migrate[n]` upgrades attrs from version n to n + 1. All nodes are at v1 in
 * V1, so there is nothing to migrate yet; the mechanism is tested with a
 * fixture registry.
 */
export const NODE_MIGRATIONS: NodeMigrations = {
  image: { v: 1, migrate: {} },
  button: { v: 1, migrate: {} },
  columns: { v: 1, migrate: {} },
  embed: { v: 1, migrate: {} },
  spacer: { v: 1, migrate: {} },
};

export class DocumentMigrationError extends Error {}

/** Returns a copy with every versioned node upgraded to its current `v`. */
export function migrateNodes(value: unknown, registry: NodeMigrations = NODE_MIGRATIONS): unknown {
  if (Array.isArray(value)) return value.map((v) => migrateNodes(v, registry));
  if (!value || typeof value !== "object") return value;
  const node = { ...(value as Record<string, unknown>) };
  const entry = typeof node.type === "string" ? registry[node.type] : undefined;
  if (entry && node.attrs && typeof node.attrs === "object") {
    let attrs = { ...(node.attrs as Attrs) };
    let v = typeof attrs.v === "number" ? attrs.v : 1;
    if (v > entry.v) throw new DocumentMigrationError(`${node.type} v${v} is newer than this code (v${entry.v})`);
    while (v < entry.v) {
      const step = entry.migrate[v];
      if (!step) throw new DocumentMigrationError(`${node.type}: no migration from v${v}`);
      attrs = { ...step(attrs), v: v + 1 };
      v++;
    }
    node.attrs = { ...attrs, v };
  }
  if (Array.isArray(node.content)) node.content = node.content.map((c) => migrateNodes(c, registry));
  return node;
}

export type ParseResult =
  | { ok: true; document: StoredDocument; bytes: number; nodes: number }
  | { ok: false; error: "too_large" | "too_many_nodes" | "unsupported_version" | "invalid"; issues?: string[] };

export function parseDocument(input: unknown, registry: NodeMigrations = NODE_MIGRATIONS): ParseResult {
  const json = JSON.stringify(input ?? null);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_DOCUMENT_BYTES) return { ok: false, error: "too_large" };
  const doc = (input as { doc?: unknown } | null)?.doc;
  const nodes = countNodes(doc, MAX_NODES);
  if (nodes > MAX_NODES) return { ok: false, error: "too_many_nodes" };
  if ((input as { v?: unknown } | null)?.v !== DOCUMENT_VERSION) return { ok: false, error: "unsupported_version" };

  let migrated: unknown;
  try {
    migrated = { v: DOCUMENT_VERSION, doc: migrateNodes(doc, registry) };
  } catch (e) {
    if (e instanceof DocumentMigrationError) return { ok: false, error: "unsupported_version", issues: [e.message] };
    throw e;
  }
  const duplicates = duplicateIds(migrated);
  if (duplicates.length) return { ok: false, error: "invalid", issues: duplicates.map((id) => `duplicate id ${id}`) };
  const result = storedDocumentSchema.safeParse(migrated);
  if (!result.success) {
    return {
      ok: false,
      error: "invalid",
      issues: result.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { ok: true, document: trimTrailingEmptyParagraphs(result.data), bytes, nodes };
}

/**
 * The editor keeps an empty paragraph after a final block so there is always
 * somewhere to type (Tiptap's TrailingNode). It is not content: drop it on
 * save, and the editor adds it back on load. Keeps at least one node.
 */
function trimTrailingEmptyParagraphs(document: StoredDocument): StoredDocument {
  const content = [...document.doc.content];
  while (content.length > 1) {
    const last = content.at(-1)!;
    if (last.type !== "paragraph" || (last.content?.length ?? 0) > 0) break;
    content.pop();
  }
  return { ...document, doc: { ...document.doc, content } };
}

/** Block ids must be unique within a document (the editor re-ids pasted copies). */
function duplicateIds(value: unknown): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  const stack: unknown[] = [value];
  while (stack.length) {
    const n = stack.pop() as { attrs?: { id?: unknown }; content?: unknown; doc?: unknown } | null;
    if (!n || typeof n !== "object") continue;
    const id = n.attrs?.id;
    if (typeof id === "string") (seen.has(id) ? dupes : seen).add(id);
    if (Array.isArray(n.content)) stack.push(...n.content);
    if (n.doc) stack.push(n.doc);
  }
  return [...dupes];
}

/** Deterministic JSON (sorted keys) so equal documents hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
