// @vitest-environment happy-dom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { mapPastedHeadings, TEXT_ID_TYPES, TEXT_NODE_TYPES } from "@/blocks/text-nodes/extensions";
import { parseDocument } from "@/modules/content/shared";
import { editorExtensions } from "./extensions";

/**
 * The editor's text nodes (M5-4), in a real headless Tiptap editor: what the
 * schema holds, the ids it gives, and what pasted HTML becomes.
 */

// happy-dom lacks the legacy CSSStyleSheet.rules alias that ProseMirror reads when pasted HTML has <style> (ADR 0003 gap 10).
if (!("rules" in CSSStyleSheet.prototype)) {
  Object.defineProperty(CSSStyleSheet.prototype, "rules", {
    get(this: CSSStyleSheet) {
      return this.cssRules;
    },
  });
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENTRY = "0192f000-0000-7000-8000-000000000002";
const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

async function makeEditor(content: JSONContent | string) {
  let created!: () => void;
  const ready = new Promise<void>((resolve) => (created = resolve));
  const editor = new Editor({ element: document.createElement("div"), extensions: editorExtensions({ nodeViews: false }), content, onCreate: () => created() });
  editors.push(editor);
  await ready;
  return editor;
}
function paste(editor: Editor, html: string) {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/html", html);
  editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
}
const typesIn = (editor: Editor) => {
  const types = new Set<string>([editor.state.doc.type.name]);
  editor.state.doc.descendants((node) => void types.add(node.type.name));
  return [...types].sort();
};

const id = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const textDocument = {
  type: "doc",
  content: [
    { type: "heading", attrs: { id: id(1), level: 2 }, content: [{ type: "text", text: "What we do" }] },
    {
      type: "paragraph",
      attrs: { id: id(2) },
      content: [
        { type: "text", text: "Fast", marks: [{ type: "bold" }] },
        { type: "text", text: " and " },
        { type: "text", text: "careful", marks: [{ type: "italic" }, { type: "strike" }, { type: "underline" }] },
        { type: "text", text: ", " },
        { type: "text", text: "code()", marks: [{ type: "code" }] },
        { type: "text", text: " " },
        { type: "text", text: "services", marks: [{ type: "link", attrs: { href: `entry:${ENTRY}` } }] },
      ],
    },
    { type: "blockquote", attrs: { id: id(3), cite: "A client" }, content: [{ type: "paragraph", attrs: { id: id(4) }, content: [{ type: "text", text: "Great." }] }] },
    { type: "bulletList", attrs: { id: id(5) }, content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { id: id(6) }, content: [{ type: "text", text: "One" }] }] }] },
    { type: "orderedList", attrs: { id: id(7), start: 1 }, content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { id: id(8) }, content: [{ type: "text", text: "First" }] }] }] },
    { type: "horizontalRule", attrs: { id: id(9), style: "line" } },
    { type: "heading", attrs: { id: id(10), level: 4 }, content: [{ type: "text", text: "Small" }] },
  ],
};

describe("the text nodes", () => {
  it("every text block of plan §6.1 loads and comes back as the same stored document", async () => {
    const editor = await makeEditor(textDocument);
    const result = parseDocument({ v: 1, doc: editor.getJSON() });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.ok && result.document).toEqual(parseDocument({ v: 1, doc: textDocument }).ok && (parseDocument({ v: 1, doc: textDocument }) as { document: unknown }).document);
    expect(typesIn(editor)).toEqual([...TEXT_NODE_TYPES].sort());
  });

  it("gives a UUIDv7 id to every block that has none, and keeps those it has", async () => {
    const editor = await makeEditor("<h2>Title</h2><p>Text</p><ul><li><p>Item</p></li></ul><blockquote><p>Q</p></blockquote><hr>");
    const ids: string[] = [];
    editor.state.doc.descendants((node) => {
      if ((TEXT_ID_TYPES as readonly string[]).includes(node.type.name)) ids.push(node.attrs.id as string);
    });
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const value of ids) expect(value).toMatch(UUID_V7);
    expect(new Set(ids).size).toBe(ids.length);
    const kept = await makeEditor(textDocument);
    expect((kept.getJSON().content![0]!.attrs as { id: string }).id).toBe(id(1));
  });

  it("headings are 2 to 4 only; pasted h1 becomes h2, h5 and h6 become h4", async () => {
    expect(mapPastedHeadings('<h1 class="x">A</h1><h5>B</h5><h6>C</h6><h3>D</h3><h10>no</h10>')).toBe('<h2 class="x">A</h2><h4>B</h4><h4>C</h4><h3>D</h3><h10>no</h10>');
    const editor = await makeEditor({ type: "doc", content: [{ type: "paragraph" }] });
    paste(editor, "<h1>Big</h1><h5>Smaller</h5><h6>Smallest</h6><h3>Middle</h3>");
    const headings: [number, string][] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "heading") headings.push([node.attrs.level as number, node.textContent]);
    });
    expect(headings).toEqual([[2, "Big"], [4, "Smaller"], [4, "Smallest"], [3, "Middle"]]);
  });

  it("pasted hostile HTML becomes allowed nodes only: no script, frame, handler, unsafe link or invalid custom block survives", async () => {
    const editor = await makeEditor({ type: "doc", content: [{ type: "paragraph" }] });
    paste(
      editor,
      `<p>Hello <script>alert(1)</script><img src=x onerror="alert(1)">
        <a href="javascript:alert(1)">bad</a> <a href="https://ok.example/" onclick="alert(1)">good</a>
        <a href="data:text/html,<script>alert(1)</script>">data</a> <a href="mailto:hi@example.com">mail</a>
        <span style="background:url(javascript:alert(1))" onmouseover="alert(1)">styled</span></p>
       <iframe src="https://evil.example"></iframe><object data="x"></object><style>p{color:red}</style>
       <pre><code>code()</code></pre><table><tr><td>cell</td></tr></table>
       <div data-forge-node="button" data-label="&quot;Pay&quot;" data-href="&quot;javascript:alert(1)&quot;"></div>
       <div data-forge-node="embed" data-provider="&quot;youtube&quot;" data-url="&quot;https://evil.example/x&quot;"></div>`,
    );
    const json = JSON.stringify(editor.getJSON());
    expect(json).not.toMatch(/<script|alert|onerror|onclick|onmouseover|javascript:|data:text|evil\.example|url\(|Pay/i);
    expect(json).toContain('"href":"https://ok.example/"');
    expect(json).toContain('"href":"mailto:hi@example.com"');
    expect(typesIn(editor).every((type) => TEXT_NODE_TYPES.has(type))).toBe(true); // the button and the embed above were invalid: dropped
    expect(parseDocument({ v: 1, doc: editor.getJSON() }).ok).toBe(true);
  });

  it("there is no way to hold an image (M6-4), a code block or a line break; the marks are the six of plan §6.1", async () => {
    const editor = await makeEditor({ type: "doc", content: [{ type: "paragraph" }] });
    for (const name of ["image", "codeBlock", "hardBreak"]) expect(editor.schema.nodes[name], name).toBeUndefined();
    for (const name of ["button", "columns", "column", "embed", "spacer"]) expect(editor.schema.nodes[name], name).toBeDefined();
    expect(Object.keys(editor.schema.marks).sort()).toEqual(["bold", "code", "italic", "link", "strike", "underline"]);
  });
});
