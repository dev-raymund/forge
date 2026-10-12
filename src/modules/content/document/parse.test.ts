import { describe, expect, it } from "vitest";
import { documentProblem, emptyDocument, migrateNodes, parseDocument, type NodeMigrations } from "./parse";
import { MAX_NODES, type StoredDocument } from "./schema";

/**
 * The document pipeline (plan §6.2; from the M0-5 spike, ADR 0003): what saving
 * and publishing accept (M5-3).
 */

/** A document using all 11 V1 block types, plus marks and an internal link (the spike's fixture). */
const MEDIA_ID = "0192e000-0000-7000-8000-000000000001";
const ENTRY_ID = "0192f000-0000-7000-8000-000000000002";

const id = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const sampleDocument: StoredDocument = {
  v: 1,
  doc: {
    type: "doc",
    content: [
      { type: "heading", attrs: { id: id(1), level: 2 }, content: [{ type: "text", text: "What we do" }] },
      {
        type: "paragraph",
        attrs: { id: id(2) },
        content: [
          { type: "text", text: "We build " },
          { type: "text", text: "fast", marks: [{ type: "bold" }] },
          { type: "text", text: ", " },
          { type: "text", text: "careful", marks: [{ type: "italic" }, { type: "underline" }] },
          { type: "text", text: " sites. See our " },
          { type: "text", text: "services", marks: [{ type: "link", attrs: { href: `entry:${ENTRY_ID}` } }] },
          { type: "text", text: " or " },
          { type: "text", text: "email us", marks: [{ type: "link", attrs: { href: "mailto:hi@example.com" } }] },
          { type: "text", text: "." },
        ],
      },
      {
        type: "blockquote",
        attrs: { id: id(3), cite: "A happy client" },
        content: [{ type: "paragraph", attrs: { id: id(4) }, content: [{ type: "text", text: "Great work." }] }],
      },
      {
        type: "bulletList",
        attrs: { id: id(5) },
        content: [
          { type: "listItem", content: [{ type: "paragraph", attrs: { id: id(6) }, content: [{ type: "text", text: "One" }] }] },
          { type: "listItem", content: [{ type: "paragraph", attrs: { id: id(7) }, content: [{ type: "text", text: "Two" }] }] },
        ],
      },
      {
        type: "orderedList",
        attrs: { id: id(8), start: 1 },
        content: [
          { type: "listItem", content: [{ type: "paragraph", attrs: { id: id(9) }, content: [{ type: "text", text: "First" }] }] },
        ],
      },
      { type: "horizontalRule", attrs: { id: id(10), style: "line" } },
      {
        type: "image",
        attrs: { id: id(11), v: 1, mediaId: MEDIA_ID, alt: null, caption: "Our team", size: "wide", link: null },
      },
      {
        type: "columns",
        attrs: { id: id(12), v: 1, count: 2, ratio: "2:1", stackOnMobile: true },
        content: [
          {
            type: "column",
            attrs: { id: id(13) },
            content: [{ type: "paragraph", attrs: { id: id(14) }, content: [{ type: "text", text: "Left" }] }],
          },
          {
            type: "column",
            attrs: { id: id(15) },
            content: [
              {
                type: "button",
                attrs: { id: id(16), v: 1, label: "Contact us", href: "/contact", style: "primary", align: "start", newTab: false },
              },
            ],
          },
        ],
      },
      {
        type: "embed",
        attrs: { id: id(17), v: 1, provider: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", aspect: "16:9" },
      },
      { type: "spacer", attrs: { id: id(18), v: 1, size: "md" } },
    ],
  },
};


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

describe("new documents and refusals (M5-3)", () => {
  it("a new entry's document is one empty paragraph with an id, and it is valid", () => {
    const document = emptyDocument();
    expect(document.doc.content).toHaveLength(1);
    expect(document.doc.content[0]).toMatchObject({ type: "paragraph", attrs: { id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(parseDocument(document)).toMatchObject({ ok: true, document });
    expect(emptyDocument().doc.content[0]).not.toEqual(document.doc.content[0]);
  });

  it("each refusal has a sentence for the person, without the details", () => {
    expect(documentProblem({ ok: false, error: "too_large" })).toBe("This content is too large to save (the limit is 1 MB).");
    expect(documentProblem({ ok: false, error: "too_many_nodes" })).toBe("This content has too many blocks and pieces of text (the limit is 2,000).");
    expect(documentProblem({ ok: false, error: "unsupported_version" })).toMatch(/newer version/);
    expect(documentProblem({ ok: false, error: "invalid", issues: ["0.attrs.href: Unsupported link"] })).toBe("This content contains something Forge cannot save.");
  });

  it("an empty document, or one that is not a document, is refused", () => {
    for (const input of [{}, null, "text", { v: 1 }, { v: 1, doc: { type: "doc", content: [] } }, { v: 1, doc: { type: "page", content: [] } }]) {
      expect(parseDocument(input).ok, JSON.stringify(input)).toBe(false);
    }
  });
});
