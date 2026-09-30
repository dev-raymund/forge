import { describe, expect, it } from "vitest";
import { migrateNodes, parseDocument, type NodeMigrations } from "./document";
import { sampleDocument } from "./fixtures";
import { MAX_NODES } from "./schema";

const clone = <T>(v: T): T => structuredClone(v);
const top = (doc: { doc: { content: unknown[] } }) => doc.doc.content as Record<string, unknown>[];
const ID = "01920000-0000-7000-8000-00000000abcd";

describe("validation (closed schema)", () => {
  it("accepts a document with all 11 block types", () => {
    const result = parseDocument(sampleDocument);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.ok && result.document).toEqual(sampleDocument);
  });

  it("strips attributes the schema does not know (e.g. Tiptap's link target/rel/class)", () => {
    const doc = clone(sampleDocument);
    const para = top(doc)[1] as { content: { marks?: { attrs?: Record<string, unknown> }[] }[] };
    Object.assign(para.content[5]!.marks![0]!.attrs!, { target: "_blank", rel: null, class: null, onclick: "x" });
    const result = parseDocument(doc);
    expect(result.ok && result.document).toEqual(sampleDocument);
  });

  it.each([
    ["an unknown node type", { type: "html", attrs: { id: ID, html: "<script>alert(1)</script>" } }],
    ["a heading level outside 2–4", { type: "heading", attrs: { id: ID, level: 1 } }],
    ["a node without a stable id", { type: "paragraph", attrs: {} }],
    ["a javascript: button", { type: "button", attrs: { id: ID, v: 1, label: "x", href: "javascript:alert(1)" } }],
    ["a protocol-relative button", { type: "button", attrs: { id: ID, v: 1, label: "x", href: "//evil.example" } }],
    ["an embed from an unlisted host", { type: "embed", attrs: { id: ID, v: 1, provider: "youtube", url: "https://evil.example/watch?v=dQw4w9WgXcQ" } }],
    ["an embed with an unknown provider", { type: "embed", attrs: { id: ID, v: 1, provider: "tiktok", url: "https://tiktok.com/x" } }],
    ["an image without a media id", { type: "image", attrs: { id: ID, v: 1, mediaId: null } }],
    ["a columns node whose count disagrees with its columns", {
      type: "columns",
      attrs: { id: ID, v: 1, count: 3, ratio: "1:1:1" },
      content: [
        { type: "column", attrs: { id: ID }, content: [{ type: "paragraph", attrs: { id: ID } }] },
        { type: "column", attrs: { id: ID }, content: [{ type: "paragraph", attrs: { id: ID } }] },
      ],
    }],
    ["a javascript: link mark", { type: "paragraph", attrs: { id: ID }, content: [
      { type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
    ] }],
    ["an unknown mark", { type: "paragraph", attrs: { id: ID }, content: [{ type: "text", text: "x", marks: [{ type: "script" }] }] }],
  ])("rejects %s", (_name, node) => {
    const doc = clone(sampleDocument);
    top(doc).push(node as never);
    const result = parseDocument(doc);
    expect(result).toMatchObject({ ok: false, error: "invalid" });
  });

  it("rejects nested columns", () => {
    const doc = clone(sampleDocument);
    const columns = top(doc)[7] as { content: { content: unknown[] }[] };
    columns.content[0]!.content.push(clone(columns));
    expect(parseDocument(doc)).toMatchObject({ ok: false, error: "invalid" });
  });

  it("rejects columns inside a list item or a quote", () => {
    const columns = clone(top(sampleDocument)[7]);
    const inQuote = clone(sampleDocument);
    (top(inQuote)[2] as { content: unknown[] }).content.push(columns);
    expect(parseDocument(inQuote)).toMatchObject({ ok: false, error: "invalid" });
  });

  it(`rejects more than ${MAX_NODES} nodes and more than 1 MB`, () => {
    const many = { v: 1, doc: { type: "doc", content: Array.from({ length: MAX_NODES }, () => ({ type: "paragraph", attrs: { id: ID } })) } };
    expect(parseDocument(many)).toMatchObject({ ok: false, error: "too_many_nodes" });
    const big = clone(sampleDocument);
    top(big).push({ type: "paragraph", attrs: { id: ID }, content: [{ type: "text", text: "x".repeat(1_000_001) }] } as never);
    expect(parseDocument(big)).toMatchObject({ ok: false, error: "too_large" });
  });

  it("rejects an unknown document version", () => {
    expect(parseDocument({ ...sampleDocument, v: 2 })).toMatchObject({ ok: false, error: "unsupported_version" });
  });
});

describe("per-node versions (`v` + migrate)", () => {
  // Fixture: pretend button v2 renamed `text` → `label`.
  const registry: NodeMigrations = {
    button: { v: 2, migrate: { 1: ({ text, ...rest }) => ({ ...rest, label: text }) } },
  };

  it("upgrades old nodes step by step, anywhere in the tree", () => {
    const old = { type: "doc", content: [
      { type: "columns", attrs: {}, content: [{ type: "column", content: [{ type: "button", attrs: { v: 1, text: "Go" } }] }] },
    ] };
    const migrated = migrateNodes(old, registry) as typeof old;
    expect(migrated.content[0]!.content[0]!.content[0]!.attrs).toEqual({ v: 2, label: "Go" });
  });

  it("refuses documents written by newer code instead of guessing", () => {
    const doc = clone(sampleDocument);
    (top(doc)[9]!.attrs as { v: number }).v = 9;
    expect(parseDocument(doc)).toMatchObject({ ok: false, error: "unsupported_version" });
  });
});
