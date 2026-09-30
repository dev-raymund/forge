// @vitest-environment happy-dom
import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "./document";
import { forgeExtensions, ID_TYPES } from "./extensions";
import { renderContext, sampleDocument } from "./fixtures";
import { renderDocument } from "./render";
import type { Columns } from "./schema";

/**
 * The real Tiptap editor, headless (happy-dom), with the exact extension set
 * the browser uses minus React NodeViews. Drag reorder needs a real browser;
 * see the Playwright spec.
 */

// happy-dom lacks the legacy CSSStyleSheet.rules alias that ProseMirror reads when pasted HTML has <style>.
if (!("rules" in CSSStyleSheet.prototype)) {
  Object.defineProperty(CSSStyleSheet.prototype, "rules", {
    get(this: CSSStyleSheet) {
      return this.cssRules;
    },
  });
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

/** Resolves after Tiptap's (asynchronous) `create` event, when UniqueID has assigned ids. */
async function makeEditor(content: JSONContent | string) {
  let created!: () => void;
  const ready = new Promise<void>((resolve) => (created = resolve));
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: forgeExtensions,
    content,
    onCreate: () => created(),
  });
  editors.push(editor);
  await ready;
  return editor;
}
const stored = (editor: Editor) => ({ v: 1, doc: editor.getJSON() });
const texts = (editor: Editor) =>
  editor.getJSON().content!.map((n: JSONContent) => n.content?.[0]?.text ?? n.type);

function ids(node: JSONContent, out: string[] = []): string[] {
  if (node.type && ID_TYPES.includes(node.type)) out.push(node.attrs?.id as string);
  node.content?.forEach((c) => ids(c, out));
  return out;
}

function pressAlt(editor: Editor, key: "ArrowUp" | "ArrowDown") {
  const event = new KeyboardEvent("keydown", { key, altKey: true, bubbles: true });
  return editor.view.someProp("handleKeyDown", (f) => f(editor.view, event)) ?? false;
}

/** A real paste event, as the browser sends it (UniqueID strips pasted ids only on this path). */
function paste(editor: Editor, html: string) {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/html", html);
  editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
}

describe("serialization", () => {
  it("JSON → editor → JSON round-trips all 11 blocks (after normalization)", async () => {
    const editor = await makeEditor(sampleDocument.doc);
    const result = parseDocument(stored(editor));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.ok && result.document).toEqual(sampleDocument);
  });

  it("editor HTML (the in-editor clipboard format) parses back to the same document", async () => {
    const html = await (await makeEditor(sampleDocument.doc)).getHTML();
    const result = parseDocument(stored(await makeEditor(html)));
    expect(result.ok && result.document).toEqual(sampleDocument);
  });
});

describe("stable ids", () => {
  it("assigns a UUIDv7 id to every block, including nested ones", async () => {
    const editor = await makeEditor("<h2>Title</h2><p>Text</p><ul><li><p>Item</p></li></ul>");
    const all = ids(editor.getJSON());
    expect(all).toHaveLength(5); // heading, paragraph, bulletList, list paragraph… and the doc's trailing paragraph
    all.forEach((id) => expect(id).toMatch(UUID_V7));
  });

  it("keeps ids across edits", async () => {
    const editor = await makeEditor(sampleDocument.doc);
    const before = ids(editor.getJSON());
    editor.chain().setTextSelection(3).insertContent("Hey ").run();
    expect(ids(editor.getJSON())).toEqual(before);
  });

  it("re-ids duplicates on copy/paste, and the originals keep theirs", async () => {
    const editor = await makeEditor(sampleDocument.doc);
    const fixtureIds = ids(sampleDocument.doc);
    // Paste the whole document again at the end (into the trailing empty paragraph).
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    paste(editor, (await makeEditor(sampleDocument.doc)).getHTML());
    const after = ids(editor.getJSON());
    expect(after.length).toBeGreaterThanOrEqual(2 * fixtureIds.length);
    expect(new Set(after).size).toBe(after.length); // no duplicates
    expect(after.slice(0, fixtureIds.length)).toEqual(fixtureIds); // originals untouched
    const result = parseDocument(stored(editor));
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});

describe("closed schema in the editor", () => {
  it("cannot represent nested columns", async () => {
    const editor = await makeEditor(sampleDocument.doc);
    const columns = sampleDocument.doc.content[7] as Columns;
    const nested = { type: "doc", content: [{ ...columns, content: [{ type: "column", content: [columns] }, columns.content[1]] }] };
    expect(() => editor.schema.nodeFromJSON(nested).check()).toThrow();

    // Inserting columns inside a column puts them outside it, never inside.
    let insideColumn = -1;
    editor.state.doc.descendants((node, pos) => {
      if (insideColumn < 0 && node.type.name === "column") insideColumn = pos + 2;
    });
    editor.chain().setTextSelection(insideColumn).insertContent(columns).run();
    const json = JSON.stringify(editor.getJSON());
    const columnJson = editor.getJSON().content!.filter((n) => n.type === "columns").flatMap((n) => n.content!);
    expect(JSON.stringify(columnJson)).not.toContain('"type":"columns"');
    expect(json).toContain('"type":"columns"');
  });

  it("keeps columns.count and ratio in sync with the actual columns", async () => {
    const editor = await makeEditor(sampleDocument.doc);
    const column = (text: string) => ({ type: "column", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    // Three columns claiming count 2 and a two-part ratio, as a partial paste can produce.
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "columns",
      attrs: { v: 1, count: 2, ratio: "2:1" },
      content: [column("a"), column("b"), column("c")],
    });
    const inserted = editor.getJSON().content!.filter((n) => n.type === "columns").at(-1)!;
    expect(inserted.content).toHaveLength(3);
    expect(inserted.attrs).toMatchObject({ count: 3, ratio: "1:1:1" });
    expect(parseDocument(stored(editor)).ok).toBe(true);
  });

  it("normalizes pasted hostile HTML into allowed nodes only", async () => {
    const editor = await makeEditor({ type: "doc", content: [{ type: "paragraph" }] });
    paste(editor, `
      <p>Hello <script>alert(1)</script><img src=x onerror="alert(1)">
        <a href="javascript:alert(1)">bad</a> <a href="https://ok.example/" onclick="alert(1)">good</a>
        <span style="background:url(javascript:alert(1))" onmouseover="alert(1)">styled</span></p>
      <iframe src="https://evil.example"></iframe>
      <object data="x"></object><style>p{color:red}</style>
      <h1>Title</h1><h6>Small</h6><pre><code>code()</code></pre>
      <div data-forge-node="button" data-label="&quot;Pay&quot;" data-href="&quot;javascript:alert(1)&quot;"></div>
      <div data-forge-node="embed" data-provider="&quot;youtube&quot;" data-url="&quot;https://evil.example/x&quot;"></div>
      <div data-forge-node="button" data-label="&quot;Ok&quot;" data-href="&quot;/contact&quot;"></div>`);

    const json = JSON.stringify(editor.getJSON());
    expect(json).not.toMatch(/<script|alert|onerror|onclick|onmouseover|javascript:|evil\.example|url\(/i);
    expect(json).toContain('"href":"https://ok.example/"');
    const types = new Set<string>();
    editor.state.doc.descendants((n) => void types.add(n.type.name));
    // h1/h6 are outside the allowed levels (2–4) and arrive as paragraphs; <pre> becomes code-marked text;
    // the button with a javascript: href and the off-list embed are dropped; the valid button survives.
    expect([...types].sort()).toEqual(["button", "paragraph", "text"]);

    const result = parseDocument(stored(editor));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const html = renderToStaticMarkup(renderDocument(result.ok ? result.document : null, renderContext()) as never);
    expect(html).not.toMatch(/<script|javascript:|on\w+=/i);
  });
});

describe("keyboard reorder", () => {
  const three = "<p>A</p><p>B</p><p>C</p>";

  it("Alt+↑ / Alt+↓ move the current top-level block and keep the caret in it", async () => {
    const editor = await makeEditor(three);
    const posInC = editor.state.doc.content.size - 2;
    editor.commands.setTextSelection(posInC);
    expect(pressAlt(editor, "ArrowUp")).toBe(true);
    expect(texts(editor)).toEqual(["A", "C", "B"]);
    expect(editor.state.selection.$from.parent.textContent).toBe("C");
    expect(pressAlt(editor, "ArrowUp")).toBe(true);
    expect(texts(editor)).toEqual(["C", "A", "B"]);
    expect(pressAlt(editor, "ArrowUp")).toBe(false); // already first
    expect(pressAlt(editor, "ArrowDown")).toBe(true);
    expect(texts(editor)).toEqual(["A", "C", "B"]);
  });

  it("a move is one undo step, and redo re-applies it", async () => {
    const editor = await makeEditor(three);
    editor.commands.setTextSelection(4); // in B
    editor.commands.moveBlockDown();
    expect(texts(editor)).toEqual(["A", "C", "B"]);
    editor.commands.undo();
    expect(texts(editor)).toEqual(["A", "B", "C"]);
    editor.commands.redo();
    expect(texts(editor)).toEqual(["A", "C", "B"]);
  });

  it("moves a whole columns block and keeps every id", async () => {
    const editor = await makeEditor(sampleDocument.doc);
    const before = ids(editor.getJSON());
    let insideColumn = -1;
    editor.state.doc.descendants((node, pos) => {
      if (insideColumn < 0 && node.type.name === "paragraph" && editor.state.doc.resolve(pos).parent.type.name === "column") {
        insideColumn = pos + 1;
      }
    });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, insideColumn)));
    editor.commands.moveBlockUp();
    const types = editor.getJSON().content!.map((n) => n.type);
    expect(types.indexOf("columns")).toBe(6);
    expect(new Set(ids(editor.getJSON()))).toEqual(new Set(before));
  });
});
