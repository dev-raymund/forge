// @vitest-environment happy-dom
import { Editor, type JSONContent } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editableDocument, fixtureId } from "@/blocks/fixtures";
import { cleanFragment } from "@/blocks/paste-guard";
import { parseDocument } from "@/modules/content/shared";
import { EDITOR_NODE_TYPES, editorExtensions, ID_TYPES } from "./extensions";
import { runBlockAction, snapGap } from "./reorder";
import { filterCommands, slashMatch } from "./slash";

/**
 * The editor with the custom blocks (M5-5; ported from the M0-5 spike's
 * tests), headless: the exact extension list the browser uses minus the React
 * NodeViews. Dragging needs a real browser (tests/e2e/editor.spec.ts).
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
const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  vi.useRealTimers();
});

/** Resolves after Tiptap's (asynchronous) `create` event, when UniqueID has assigned ids. */
async function makeEditor(content: JSONContent | string) {
  let created!: () => void;
  const ready = new Promise<void>((resolve) => (created = resolve));
  const editor = new Editor({ element: document.createElement("div"), extensions: editorExtensions({ nodeViews: false }), content, onCreate: () => created() });
  editors.push(editor);
  await ready;
  return editor;
}
const stored = (editor: Editor) => ({ v: 1, doc: editor.getJSON() });
const texts = (editor: Editor) => editor.getJSON().content!.map((node: JSONContent) => node.content?.[0]?.text ?? node.content?.[0]?.content?.[0]?.content?.[0]?.text ?? node.type);
const topTypes = (editor: Editor) => editor.getJSON().content!.map((node) => node.type);

function ids(node: JSONContent, out: string[] = []): string[] {
  if (node.type && ID_TYPES.includes(node.type)) out.push(node.attrs?.id as string);
  node.content?.forEach((child) => ids(child, out));
  return out;
}
function pressAlt(editor: Editor, key: "ArrowUp" | "ArrowDown") {
  const event = new KeyboardEvent("keydown", { key, altKey: true, bubbles: true });
  return editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event)) ?? false;
}
/** A real paste event, as the browser sends it (UniqueID strips pasted ids only on this path). */
function paste(editor: Editor, html: string) {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/html", html);
  editor.view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
}
/** The position just inside the first paragraph that sits in a column. */
function inFirstColumn(editor: Editor): number {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === "paragraph" && editor.state.doc.resolve(pos).parent.type.name === "column") at = pos + 1;
  });
  return at;
}

describe("serialization", () => {
  it("JSON → editor → JSON round-trips every block the editor holds, unchanged", async () => {
    const editor = await makeEditor(editableDocument.doc);
    const result = parseDocument(stored(editor));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.ok && result.document).toEqual(editableDocument);
  });

  it("the editor's HTML (its clipboard format) parses back to the same document", async () => {
    const html = (await makeEditor(editableDocument.doc)).getHTML();
    const result = parseDocument(stored(await makeEditor(html)));
    expect(result.ok && result.document).toEqual(editableDocument);
  });

  it("the fixture uses every node type the editor holds", () => {
    const types = new Set<string>();
    const walk = (node: JSONContent) => {
      types.add(node.type!);
      node.content?.forEach(walk);
    };
    walk(editableDocument.doc as JSONContent);
    expect([...types].sort()).toEqual([...EDITOR_NODE_TYPES].sort());
  });
});

describe("stable ids", () => {
  it("gives a UUIDv7 id to every custom block inserted, nested ones included", async () => {
    const editor = await makeEditor("<p>/three</p>");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const match = slashMatch(editor.state)!;
    filterCommands(match.query)[0]!.run(editor, match.range);
    const columns = editor.getJSON().content![0]!;
    expect(columns).toMatchObject({ type: "columns", attrs: { count: 3, ratio: "1:1:1" } });
    const all = ids(columns);
    expect(all).toHaveLength(7); // columns, three columns, a paragraph in each
    all.forEach((id) => expect(id).toMatch(UUID_V7));
  });

  it("keeps every id across edits", async () => {
    const editor = await makeEditor(editableDocument.doc);
    const before = ids(editor.getJSON());
    editor.chain().setTextSelection(3).insertContent("Hey ").run();
    editor.chain().setTextSelection(inFirstColumn(editor)).insertContent("More ").run();
    expect(ids(editor.getJSON())).toEqual(before);
  });

  it("re-ids duplicates on copy and paste; the originals keep theirs", async () => {
    const editor = await makeEditor(editableDocument.doc);
    const original = ids(editableDocument.doc as JSONContent);
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "paragraph" });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1); // in that empty paragraph
    paste(editor, (await makeEditor(editableDocument.doc)).getHTML());
    const after = ids(editor.getJSON());
    expect(after.length).toBeGreaterThanOrEqual(2 * original.length);
    expect(new Set(after).size).toBe(after.length);
    expect(after.slice(0, original.length)).toEqual(original);
    expect(parseDocument(stored(editor)).ok).toBe(true);
  });
});

describe("the closed schema in the editor", () => {
  it("cannot represent nested columns", async () => {
    const editor = await makeEditor(editableDocument.doc);
    const columns = editableDocument.doc.content.find((node) => node.type === "columns") as JSONContent;
    const nested = { type: "doc", content: [{ ...columns, content: [{ type: "column", content: [columns] }, columns.content![1]] }] };
    expect(() => editor.schema.nodeFromJSON(nested).check()).toThrow();

    // Inserting columns inside a column (a paste can) splits the layout around them: they never land inside it.
    const fresh = JSON.parse(JSON.stringify(columns).replace(/"id":"[^"]+"/g, '"id":null')) as JSONContent;
    editor.chain().setTextSelection(inFirstColumn(editor)).insertContent(fresh).run();
    const inner = editor.getJSON().content!.filter((node) => node.type === "columns").flatMap((node) => node.content!);
    expect(JSON.stringify(inner)).not.toContain('"type":"columns"');
    expect(topTypes(editor).filter((type) => type === "columns").length).toBeGreaterThanOrEqual(2);
    const result = parseDocument(stored(editor));
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("keeps a columns block's count and ratio in step with its columns", async () => {
    const editor = await makeEditor(editableDocument.doc);
    const column = (text: string) => ({ type: "column", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    // Three columns claiming two and a two-part ratio, as a partial paste can produce.
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "columns", attrs: { v: 1, count: 2, ratio: "2:1" }, content: [column("a"), column("b"), column("c")] });
    const inserted = editor.getJSON().content!.filter((node) => node.type === "columns").at(-1)!;
    expect(inserted.content).toHaveLength(3);
    expect(inserted.attrs).toMatchObject({ count: 3, ratio: "1:1:1" });
    expect(parseDocument(stored(editor)).ok).toBe(true);
  });

  it("an image (M6-4) has no node here: a document holding one is not opened for editing", () => {
    expect(EDITOR_NODE_TYPES.has("image")).toBe(false);
    for (const type of ["button", "columns", "column", "embed", "spacer"]) expect(EDITOR_NODE_TYPES.has(type), type).toBe(true);
  });
});

describe("pasting custom blocks", () => {
  it("drops pasted custom blocks whose attributes fail their schema, and keeps valid ones", async () => {
    const editor = await makeEditor({ type: "doc", content: [{ type: "paragraph" }] });
    const data = (attrs: Record<string, unknown>) => Object.entries(attrs).map(([key, value]) => `data-${key.toLowerCase()}="${JSON.stringify(value).replaceAll('"', "&quot;")}"`).join(" ");
    paste(
      editor,
      `<p>Hello</p>
      <div data-forge-node="button" ${data({ v: 1, label: "Pay", href: "javascript:alert(1)" })}></div>
      <div data-forge-node="button" ${data({ v: 1, label: "", href: "/contact" })}></div>
      <div data-forge-node="embed" ${data({ v: 1, provider: "youtube", url: "https://evil.example/x" })}></div>
      <div data-forge-node="embed" ${data({ v: 1, provider: "generic", url: "https://localhost/admin" })}></div>
      <div data-forge-node="embed" ${data({ v: 1, provider: "generic", url: "http://insecure.org/" })}></div>
      <div data-forge-node="spacer" ${data({ v: 1, size: "huge" })}></div>
      <div data-forge-node="columns" ${data({ v: 1, count: 2, ratio: "9:1" })}><div data-forge-node="column"><p>x</p></div><div data-forge-node="column"><p>y</p></div></div>
      <div data-forge-node="image" ${data({ v: 1, mediaId: fixtureId(99) })}></div>
      <div data-forge-node="button" ${data({ v: 1, label: "Ok", href: "/contact" })}></div>
      <div data-forge-node="spacer" ${data({ v: 1, size: "xl" })}></div>`,
    );
    const json = JSON.stringify(editor.getJSON());
    expect(json).not.toMatch(/javascript:|evil\.example|localhost|insecure|huge|9:1|mediaId/);
    expect(topTypes(editor).filter((type) => type !== "paragraph")).toEqual(["button", "spacer"]);
    expect(editor.getJSON().content!.find((node) => node.type === "button")!.attrs).toMatchObject({ label: "Ok", href: "/contact" });
    const result = parseDocument(stored(editor));
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("keeps part of a columns block (its ratio no longer fitting) and re-syncs it", async () => {
    const editor = await makeEditor({ type: "doc", content: [{ type: "paragraph" }] });
    const { columns, column, paragraph } = editor.schema.nodes;
    const part = columns!.create({ v: 1, count: 3, ratio: "1:2:1", stackOnMobile: true }, [
      column!.create(null, paragraph!.create(null, editor.schema.text("b"))),
      column!.create(null, paragraph!.create(null, editor.schema.text("c"))),
    ]);
    const cleaned = cleanFragment(Fragment.from(part));
    expect(cleaned.childCount).toBe(1);
    editor.commands.insertContentAt(0, cleaned.firstChild!.toJSON() as JSONContent);
    expect(editor.getJSON().content![0]!.attrs).toMatchObject({ count: 2, ratio: "1:1" });
  });
});

describe("reordering with the keyboard", () => {
  const three = "<p>A</p><p>B</p><p>C</p>";

  it("Alt+↑ / Alt+↓ move the block holding the caret and keep the caret in it", async () => {
    const editor = await makeEditor(three);
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    expect(pressAlt(editor, "ArrowUp")).toBe(true);
    expect(texts(editor)).toEqual(["A", "C", "B"]);
    expect(editor.state.selection.$from.parent.textContent).toBe("C");
    expect(pressAlt(editor, "ArrowUp")).toBe(true);
    expect(texts(editor)).toEqual(["C", "A", "B"]);
    expect(pressAlt(editor, "ArrowUp")).toBe(false); // already first
    expect(pressAlt(editor, "ArrowDown")).toBe(true);
    expect(texts(editor)).toEqual(["A", "C", "B"]);
  });

  it("each move is its own undo step, however quickly the moves follow each other", async () => {
    const editor = await makeEditor(three);
    editor.commands.setTextSelection(2); // in A
    // Quicker than ProseMirror's grouping delay (500 ms): the moves happen in the same millisecond.
    pressAlt(editor, "ArrowDown");
    pressAlt(editor, "ArrowDown");
    expect(texts(editor)).toEqual(["B", "C", "A"]);
    editor.commands.undo();
    expect(texts(editor)).toEqual(["B", "A", "C"]);
    editor.commands.undo();
    expect(texts(editor)).toEqual(["A", "B", "C"]);
    editor.commands.redo();
    expect(texts(editor)).toEqual(["B", "A", "C"]);
  });

  it("each move is its own undo step when the moves are slower than the grouping delay too", async () => {
    const editor = await makeEditor(three);
    vi.useFakeTimers({ toFake: ["Date"] });
    editor.commands.setTextSelection(2);
    pressAlt(editor, "ArrowDown");
    vi.setSystemTime(Date.now() + 2_000);
    pressAlt(editor, "ArrowDown");
    editor.commands.undo();
    expect(texts(editor)).toEqual(["B", "A", "C"]);
    editor.commands.undo();
    expect(texts(editor)).toEqual(["A", "B", "C"]);
  });

  it("typing right after a move is not undone with it", async () => {
    const editor = await makeEditor(three);
    editor.commands.setTextSelection(2);
    pressAlt(editor, "ArrowDown");
    editor.commands.insertContent("x");
    editor.commands.undo();
    expect(texts(editor)).toEqual(["B", "A", "C"]);
  });

  it("moves a whole columns block from inside a column, keeping every id", async () => {
    const editor = await makeEditor(editableDocument.doc);
    const before = ids(editor.getJSON());
    const index = topTypes(editor).indexOf("columns");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, inFirstColumn(editor))));
    editor.commands.moveBlockUp();
    expect(topTypes(editor).indexOf("columns")).toBe(index - 1);
    expect(new Set(ids(editor.getJSON()))).toEqual(new Set(before));
    expect(editor.state.selection.$from.parent.textContent).toBe("Left");
  });

  it("moves a selected atom block and keeps it selected", async () => {
    const editor = await makeEditor(editableDocument.doc);
    const index = topTypes(editor).lastIndexOf("spacer");
    let at = 0;
    for (let i = 0; i < index; i++) at += editor.state.doc.child(i).nodeSize;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
    expect(pressAlt(editor, "ArrowDown")).toBe(true);
    expect(topTypes(editor)[index + 1]).toBe("spacer");
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe("spacer");
  });
});

describe("the block menu", () => {
  it("moves the block it is opened for", async () => {
    const editor = await makeEditor("<p>A</p><p>B</p><p>C</p>");
    expect(runBlockAction(editor, 0, "down")).toBe(true);
    expect(texts(editor)).toEqual(["B", "A", "C"]);
    expect(runBlockAction(editor, 2, "down")).toBe(false);
    expect(runBlockAction(editor, 0, "up")).toBe(false);
    expect(runBlockAction(editor, 9, "delete")).toBe(false);
  });

  it("duplicates a block below itself with new ids, and the copy validates", async () => {
    const editor = await makeEditor(editableDocument.doc);
    const index = topTypes(editor).indexOf("columns");
    const original = editor.getJSON().content![index]!;
    expect(runBlockAction(editor, index, "duplicate")).toBe(true);
    const copy = editor.getJSON().content![index + 1]!;
    const strip = (node: JSONContent): JSONContent => ({ ...node, attrs: node.attrs && { ...node.attrs, id: null }, content: node.content?.map(strip) });
    expect(strip(copy)).toEqual(strip(original));
    const copyIds = ids(copy);
    expect(copyIds).toHaveLength(ids(original).length);
    copyIds.forEach((id) => expect(id).toMatch(UUID_V7));
    expect(copyIds.some((id) => ids(original).includes(id))).toBe(false);
    expect(parseDocument(stored(editor)).ok).toBe(true);
    editor.commands.undo();
    expect(editor.getJSON().content).toHaveLength(editableDocument.doc.content.length);
  });

  it("deletes a block, and deleting the last one leaves a paragraph to type in", async () => {
    const editor = await makeEditor({ type: "doc", content: [{ type: "spacer", attrs: { v: 1, size: "md" } }, { type: "paragraph", content: [{ type: "text", text: "B" }] }] });
    expect(runBlockAction(editor, 0, "delete")).toBe(true);
    expect(texts(editor)).toEqual(["B"]);
    expect(runBlockAction(editor, 0, "delete")).toBe(true);
    expect(topTypes(editor)).toEqual(["paragraph"]);
    expect(parseDocument(stored(editor)).ok).toBe(true);
  });
});

describe("inserting custom blocks from the slash menu", () => {
  it.each([
    ["button", "button", { label: "Button", href: "/", style: "primary" }],
    ["spacer", "spacer", { size: "md" }],
    ["two", "columns", { count: 2, ratio: "1:1" }],
  ])("/%s replaces the paragraph with a valid %s", async (query, type, attrs) => {
    const editor = await makeEditor("<p>Intro</p><p></p><p>Outro</p>");
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
    editor.commands.insertContent(`/${query}`);
    const match = slashMatch(editor.state)!;
    expect(filterCommands(match.query)[0]!.run(editor, match.range)).toBe(true);
    expect(topTypes(editor)).toEqual(["paragraph", type, "paragraph"]);
    expect(editor.getJSON().content![1]!.attrs).toMatchObject(attrs);
    expect(JSON.stringify(editor.getJSON())).not.toContain(`/${query}`);
    expect(parseDocument(stored(editor)).ok).toBe(true);
  });

  it("the embed asks for an address first (the editor opens a dialog rather than inserting an empty one)", () => {
    expect(filterCommands("video").map((command) => command.asks)).toEqual(["address"]);
  });
});

describe("dragging: snapping to the gaps between top-level blocks", () => {
  async function laidOut() {
    const editor = await makeEditor(editableDocument.doc);
    document.body.append(editor.view.dom.parentElement!);
    // happy-dom does no layout: each top-level block is 100px tall, one under the other.
    [...editor.view.dom.children].forEach((child, index) => {
      vi.spyOn(child, "getBoundingClientRect").mockReturnValue({ top: index * 100, height: 100, bottom: index * 100 + 100 } as DOMRect);
    });
    return editor;
  }

  it("picks the gap nearest the pointer", async () => {
    const editor = await laidOut();
    const blocks = editor.view.dom.children.length;
    expect(snapGap(editor.view, { clientY: 10, target: editor.view.dom })).toBe(0);
    expect(snapGap(editor.view, { clientY: 60, target: editor.view.dom })).toBe(1);
    expect(snapGap(editor.view, { clientY: 140, target: editor.view.dom })).toBe(1);
    expect(snapGap(editor.view, { clientY: 100 * blocks + 50, target: editor.view.dom })).toBe(blocks);
  });

  /** Drops what is selected, as Tiptap's drag handle hands it to ProseMirror (the selected blocks, moved). */
  function drop(editor: Editor, clientY: number, target: Element | null = editor.view.dom) {
    const slice = editor.state.selection.content();
    editor.view.dragging = { slice, move: true } as typeof editor.view.dragging;
    const event = { clientY, target, preventDefault: () => {} } as unknown as DragEvent;
    return editor.view.someProp("handleDrop", (handle) => handle(editor.view, event, slice, true)) ?? false;
  }
  const selectTop = (editor: Editor, index: number) => {
    let at = 0;
    for (let i = 0; i < index; i++) at += editor.state.doc.child(i).nodeSize;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
  };

  it("a dropped block lands in the gap, keeps its ids, and the move is one undo step", async () => {
    const editor = await laidOut();
    const before = topTypes(editor);
    const idsBefore = new Set(ids(editor.getJSON()));
    selectTop(editor, 0); // the heading
    expect(drop(editor, 310)).toBe(true); // the top half of block 3: the gap before it
    expect(topTypes(editor)).toEqual([before[1], before[2], before[0], ...before.slice(3)]);
    expect(new Set(ids(editor.getJSON()))).toEqual(idsBefore);
    expect(parseDocument(stored(editor)).ok).toBe(true);
    editor.commands.undo();
    expect(topTypes(editor)).toEqual(before);
  });

  it("a columns block dragged to the end keeps everything in it", async () => {
    const editor = await laidOut();
    const index = topTypes(editor).indexOf("columns");
    const columns = editor.getJSON().content![index];
    selectTop(editor, index);
    expect(drop(editor, 100 * editor.state.doc.childCount + 50)).toBe(true);
    expect(editor.getJSON().content!.at(-2)).toEqual(columns);
    expect(editor.getJSON().content!.at(-1)).toMatchObject({ type: "paragraph" }); // the editor's trailing paragraph, not content
  });

  it("dropped next to itself, nothing moves", async () => {
    const editor = await laidOut();
    const before = JSON.stringify(editor.getJSON());
    selectTop(editor, 2);
    expect(drop(editor, 210)).toBe(true); // the gap just above it
    expect(drop(editor, 290)).toBe(true); // the gap just below it
    expect(JSON.stringify(editor.getJSON())).toBe(before);
  });

  it("leaves the drop to ProseMirror over a container, and when the selection is no longer what is dragged", async () => {
    const editor = await laidOut();
    selectTop(editor, 0);
    expect(drop(editor, 10, editor.view.dom.querySelector('[data-forge-node="column"] p'))).toBe(false);
    const slice = editor.state.selection.content();
    selectTop(editor, 1);
    editor.view.dragging = { slice, move: true } as typeof editor.view.dragging;
    const event = { clientY: 310, target: editor.view.dom, preventDefault: () => {} } as unknown as DragEvent;
    expect(editor.view.someProp("handleDrop", (handle) => handle(editor.view, event, slice, true)) ?? false).toBe(false);
  });

  it("leaves a drop over a column, a quote or a list to ProseMirror", async () => {
    const editor = await laidOut();
    for (const selector of ['[data-forge-node="column"] p', "blockquote p", "li p"]) {
      expect(snapGap(editor.view, { clientY: 10, target: editor.view.dom.querySelector(selector) }), selector).toBeNull();
    }
  });
});
