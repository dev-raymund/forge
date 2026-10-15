import { describe, expect, it } from "vitest";
import { BLOCK_EDITORS, BLOCK_INSERTS } from "@/blocks/editor";
import { BLOCK_RENDERERS } from "@/blocks/render";
import { blockSchema, CUSTOM_BLOCKS, EDITABLE_BLOCK_TYPES, NODE_ATTRS, NODE_MIGRATIONS } from "@/blocks/schemas";
import { TEXT_NODE_TYPES } from "@/blocks/text-nodes/extensions";
import { EDITOR_NODE_TYPES } from "../editor/extensions";
import { SLASH_COMMANDS } from "../editor/slash";
import { migrateNodes, parseDocument, type NodeMigrations } from "./parse";
import { attrs as DOCUMENT_ATTRS, MAX_NODES } from "./schema";

/**
 * The block registry (M5-5): one definition per custom block, whose three
 * faces (schema, editor, renderer) stay in step, and nothing outside it.
 */

const ID = "01920000-0000-7000-8000-000000000001";
const doc = (...content: unknown[]) => ({ v: 1, doc: { type: "doc", content } });

describe("the registry is complete", () => {
  it("defines exactly the V1 custom blocks", () => {
    expect(CUSTOM_BLOCKS.map((block) => block.type).sort()).toEqual(["button", "column", "columns", "embed", "image", "spacer"]);
    expect([...EDITABLE_BLOCK_TYPES].sort()).toEqual(["button", "column", "columns", "embed", "image", "spacer"]); // the image since M6-4
  });

  it("every editable block has a schema, an editor node, a NodeView and a renderer (a column is drawn by its columns)", () => {
    expect(BLOCK_EDITORS.map((block) => block.type).sort()).toEqual([...EDITABLE_BLOCK_TYPES].sort());
    for (const type of EDITABLE_BLOCK_TYPES) {
      const editor = BLOCK_EDITORS.find((block) => block.type === type)!;
      expect(editor.node.name, type).toBe(type);
      if (type === "column") continue;
      expect(editor.view, type).toBeDefined();
      expect(BLOCK_RENDERERS[type], type).toBeTypeOf("function");
    }
    expect(Object.keys(BLOCK_RENDERERS).sort()).toEqual(["button", "columns", "embed", "image", "spacer"]);
  });

  it("every versioned block carries `v` and a `migrate` table, and its schema accepts only its current `v`", () => {
    for (const block of CUSTOM_BLOCKS.filter((b) => b.type !== "column")) {
      expect(block.v, block.type).toBe(1);
      expect(block.migrate, block.type).toEqual({});
      expect(NODE_MIGRATIONS[block.type], block.type).toEqual({ v: block.v, migrate: block.migrate });
      const sample = { ...block.defaults, id: ID, v: block.v + 1 };
      expect(block.attrs.safeParse(sample).success, block.type).toBe(false);
    }
    expect(NODE_MIGRATIONS.column).toBeUndefined();
  });

  it("a new block's defaults are valid (an embed and an image are made from an address or a media item)", () => {
    for (const block of CUSTOM_BLOCKS.filter((b) => !["embed", "image"].includes(b.type))) {
      expect(block.attrs.safeParse({ ...block.defaults, id: ID }).success, block.type).toBe(true);
    }
  });

  it("the document's validation is built from the registry: one definition of each node's attributes", () => {
    expect(DOCUMENT_ATTRS).toBe(NODE_ATTRS);
    expect(Object.keys(NODE_ATTRS).sort()).toEqual([...new Set([...TEXT_NODE_TYPES, ...CUSTOM_BLOCKS.map((b) => b.type)])].filter((t) => !["doc", "text", "listItem"].includes(t)).sort());
  });

  it("the editor holds every editable node and nothing else; the slash menu offers every insertable block", () => {
    expect([...EDITOR_NODE_TYPES].sort()).toEqual([...TEXT_NODE_TYPES, ...EDITABLE_BLOCK_TYPES].sort());
    for (const insert of BLOCK_INSERTS) expect(SLASH_COMMANDS.map((command) => command.key)).toContain(insert.key);
    expect(BLOCK_INSERTS.map((insert) => insert.key)).toEqual(["button", "columns-2", "columns-3", "embed", "image", "spacer"]);
  });

  it("unknown types are not blocks", () => {
    for (const type of ["video", "html", "script", "iframe", "Button", "", null, "__proto__", "constructor"]) expect(blockSchema(type), String(type)).toBeNull();
  });
});

describe("documents with unknown or unsupported content are refused, not trimmed", () => {
  it.each([
    ["an unknown block", { type: "html", attrs: { id: ID, html: "<script>alert(1)</script>" } }],
    ["an iframe node", { type: "iframe", attrs: { id: ID, src: "https://evil.example.org/" } }],
    ["a code block", { type: "codeBlock", attrs: { id: ID }, content: [{ type: "text", text: "x" }] }],
    ["a column outside columns", { type: "column", attrs: { id: ID }, content: [{ type: "paragraph", attrs: { id: ID.replace(/1$/, "2") } }] }],
  ])("%s", (_name, node) => {
    const result = parseDocument(doc(node));
    expect(result.ok).toBe(false);
  });
});

it("an attribute a block does not define is never stored (the established normalization; Tiptap adds some, such as a list's `type`)", () => {
  const result = parseDocument(doc({ type: "spacer", attrs: { id: ID, v: 1, size: "md", onclick: "alert(1)" } }));
  expect(result.ok && result.document.doc.content[0]).toEqual({ type: "spacer", attrs: { id: ID, v: 1, size: "md" } });
});

describe("size and node limits count what custom blocks hold", () => {
  let n = 0;
  const next = () => `01920000-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`;
  const section = () => ({
    type: "columns",
    attrs: { id: next(), v: 1, count: 2, ratio: "1:1", stackOnMobile: true },
    content: [0, 1].map(() => ({ type: "column", attrs: { id: next() }, content: [{ type: "spacer", attrs: { id: next(), v: 1, size: "sm" } }] })),
  });

  it(`a document of columns is refused past ${MAX_NODES} nodes, counting the columns and what they hold`, () => {
    const per = 5; // columns, two columns, a block in each
    const fits = Math.floor((MAX_NODES - 1) / per); // and the document node
    expect(parseDocument(doc(...Array.from({ length: fits }, section)))).toMatchObject({ ok: true });
    expect(parseDocument(doc(...Array.from({ length: fits + 1 }, section)))).toMatchObject({ ok: false, error: "too_many_nodes" });
  });

  it("a document over 1 MB is refused, whatever holds the bytes", () => {
    const long = Array.from({ length: 600 }, () => ({ type: "embed", attrs: { id: next(), v: 1, provider: "generic", url: `https://www.openstreetmap.org/${"x".repeat(1900)}`, aspect: "16:9" } }));
    expect(parseDocument(doc(...long))).toMatchObject({ ok: false, error: "too_large" });
  });
});

describe("migrating a block's attributes", () => {
  const registry: NodeMigrations = {
    ...NODE_MIGRATIONS,
    button: { v: 3, migrate: { 1: (attrs) => ({ ...attrs, kind: attrs.style }), 2: ({ kind, ...attrs }) => ({ ...attrs, style: kind === "secondary" ? "secondary" : "primary" }) } },
  };
  const old = { type: "button", attrs: { id: ID, v: 1, label: "Go", href: "/", style: "secondary", align: "start", newTab: false } };

  it("runs each step from the stored `v` to the current one", () => {
    expect(migrateNodes({ type: "doc", content: [{ type: "columns", content: [{ type: "column", content: [old] }] }] }, registry)).toEqual({
      type: "doc",
      content: [{ type: "columns", content: [{ type: "column", content: [{ ...old, attrs: { ...old.attrs, v: 3 } }] }] }],
    });
  });

  it("refuses a block newer than this code, and a missing step", () => {
    expect(parseDocument(doc({ ...old, attrs: { ...old.attrs, v: 2 } })).ok).toBe(false);
    expect(parseDocument(doc(old), { ...registry, button: { v: 3, migrate: { 1: (attrs) => attrs } } })).toMatchObject({ ok: false, error: "unsupported_version" });
  });

  it("a current document needs no migration", () => {
    expect(parseDocument(doc(old))).toMatchObject({ ok: true });
  });
});
