import { uuidv7 } from "uuidv7";
import { NODE_MIGRATIONS as REGISTRY_MIGRATIONS } from "@/blocks/schemas";
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
 * the editor can run it client-side before saving. From the M0-5 spike
 * (spikes/editor/document.ts, ADR 0003), unchanged but for `emptyDocument`
 * and `documentProblem`.
 */

/** A new entry's document: one empty paragraph, so the editor has somewhere to type (plan §6.2: every node has an id). */
export function emptyDocument(paragraphId: string = uuidv7()): StoredDocument {
  return { v: DOCUMENT_VERSION, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: paragraphId } }] } };
}

type Attrs = Record<string, unknown>;
export type NodeMigrations = Readonly<Record<string, { v: number; migrate: Readonly<Record<number, (attrs: Attrs) => Attrs>> }>>;

/**
 * The versioned custom nodes: `v` is the current attributes version and
 * `migrate[n]` upgrades attributes from version n to n + 1. From the block
 * registry (`src/blocks/schemas.ts`, M5-5). All nodes are at v1 in V1, so
 * there is nothing to migrate yet; the mechanism is tested with a fixture.
 */
export const NODE_MIGRATIONS: NodeMigrations = REGISTRY_MIGRATIONS as NodeMigrations;

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

/** What to tell the person whose document was refused. The details (`issues`) are for logs and tests. */
export function documentProblem(result: Extract<ParseResult, { ok: false }>): string {
  switch (result.error) {
    case "too_large":
      return "This content is too large to save (the limit is 1 MB).";
    case "too_many_nodes":
      return `This content has too many blocks and pieces of text (the limit is ${MAX_NODES.toLocaleString("en")}).`;
    case "unsupported_version":
      return "This content was saved by a newer version of Forge. Reload the page.";
    case "invalid":
      return "This content contains something Forge cannot save.";
  }
}
