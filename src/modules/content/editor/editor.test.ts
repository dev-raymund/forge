// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { DRAFT_CHANGED } from "../messages";
import { textNodeExtensions } from "@/blocks/text-nodes/extensions";
import { dedupeIds } from "./dedupe-ids";
import { nodeTypesOf, statusText } from "./entry-editor";
import { saveResultOf } from "./save-result";
import { filterCommands, SLASH_COMMANDS, slashMatch } from "./slash";

/** The editor's own logic (M5-4): the slash menu, ids before saving, the save's answer, what the status says. */

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));
async function makeEditor(content: string) {
  let created!: () => void;
  const ready = new Promise<void>((resolve) => (created = resolve));
  const editor = new Editor({ element: document.createElement("div"), extensions: textNodeExtensions, content, onCreate: () => created() });
  editors.push(editor);
  await ready;
  return editor;
}
/** The caret at the end of the document's `index`-th top-level block. */
function caretAtEndOf(editor: Editor, index: number) {
  let pos = 0;
  editor.state.doc.forEach((node, offset, i) => {
    if (i === index) pos = offset + node.nodeSize - 1;
  });
  editor.commands.setTextSelection(pos);
}

describe("the slash menu", () => {
  it("opens for `/` and a few letters alone in a top-level paragraph, with the caret at its end", async () => {
    const editor = await makeEditor("<p>/head</p><p>Some /text</p><ul><li><p>/list</p></li></ul><p>/</p><p>/two  words!</p>");
    caretAtEndOf(editor, 0);
    expect(slashMatch(editor.state)).toMatchObject({ query: "head" });
    caretAtEndOf(editor, 1);
    expect(slashMatch(editor.state)).toBeNull(); // not at the start
    caretAtEndOf(editor, 2);
    expect(slashMatch(editor.state)).toBeNull(); // inside a list
    caretAtEndOf(editor, 3);
    expect(slashMatch(editor.state)).toMatchObject({ query: "" });
    caretAtEndOf(editor, 4);
    expect(slashMatch(editor.state)).toBeNull(); // punctuation: it is text
    editor.commands.setTextSelection({ from: 1, to: 3 });
    expect(slashMatch(editor.state)).toBeNull(); // a selection
  });

  it("filters by name or keyword, case-insensitive; nothing typed lists them all", () => {
    expect(filterCommands("").map((c) => c.label)).toEqual(SLASH_COMMANDS.map((c) => c.label));
    expect(filterCommands("head").map((c) => c.label)).toEqual(["Heading 2", "Heading 3", "Heading 4"]);
    expect(filterCommands("LIST").map((c) => c.label)).toEqual(["Bulleted list", "Numbered list"]);
    expect(filterCommands("hr").map((c) => c.label)).toEqual(["Divider"]);
    expect(filterCommands("zzz")).toEqual([]);
  });

  it("each command replaces the `/query` with its block, and nothing of the slash text is left", async () => {
    const expectations: [string, string][] = [
      ["heading-2", "heading"], ["heading-3", "heading"], ["heading-4", "heading"], ["bullet-list", "bulletList"], ["ordered-list", "orderedList"],
      ["quote", "blockquote"], ["divider", "horizontalRule"], ["paragraph", "paragraph"],
    ];
    for (const [key, type] of expectations) {
      const editor = await makeEditor("<p>Before</p><p>/x</p>");
      caretAtEndOf(editor, 1);
      const match = slashMatch(editor.state)!;
      expect(SLASH_COMMANDS.find((c) => c.key === key)!.run(editor, match.range), key).toBe(true);
      const second = editor.getJSON().content![1]!;
      expect(second.type, key).toBe(type);
      expect(JSON.stringify(editor.getJSON()), key).not.toContain("/x");
      if (key.startsWith("heading")) expect(second.attrs!.level, key).toBe(Number(key.slice(-1)));
    }
  });
});

describe("before saving", () => {
  it("dedupeIds gives every repeated id a new one, keeps the first, and leaves the input alone", () => {
    const input = { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: "a" } }, { type: "paragraph", attrs: { id: "a" } }, { type: "bulletList", attrs: { id: "b" }, content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { id: "a" } }] }] }] } };
    let n = 0;
    const { document, changed } = dedupeIds(input, () => `new-${++n}`);
    expect(changed).toBe(true);
    expect(JSON.stringify(document)).toBe(JSON.stringify({ v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: "a" } }, { type: "paragraph", attrs: { id: "new-1" } }, { type: "bulletList", attrs: { id: "b" }, content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { id: "new-2" } }] }] }] } }));
    expect(input.doc.content[1]!.attrs!.id).toBe("a");
    expect(dedupeIds({ v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: "x" } }] } }).changed).toBe(false);
  });
});

describe("the save's answer", () => {
  it("success with a version is saved; the version conflict is a conflict; field errors are refused content; anything else is retried", () => {
    expect(saveResultOf({ status: "success", values: { version: "7" } })).toEqual({ ok: true, version: 7 });
    expect(saveResultOf({ status: "error", message: DRAFT_CHANGED })).toEqual({ ok: false, reason: "conflict" });
    expect(saveResultOf({ status: "error", fieldErrors: { content: ["This content contains something Forge cannot save."] } })).toEqual({
      ok: false, reason: "invalid", issues: ["This content contains something Forge cannot save."],
    });
    // Not a save that succeeded: never shown as one.
    expect(() => saveResultOf({ status: "success", values: {} })).toThrow();
    expect(() => saveResultOf({ status: "error", message: "Something went wrong. Please try again. Reference: x" })).toThrow(/Something went wrong/);
    expect(() => saveResultOf({ status: "error", message: "Not found." })).toThrow();
  });
});

describe("what the editor tells the person", () => {
  it("the status line: saved only once saved, and every way of not being saved says so", () => {
    expect(statusText({ state: "idle" })).toBe("All changes saved");
    expect(statusText({ state: "pending" })).toBe("Unsaved changes");
    expect(statusText({ state: "saving" })).toBe("Saving…");
    expect(statusText({ state: "saved", version: 3, at: new Date(2026, 9, 12, 10, 42) })).toMatch(/^Saved at 10:42/);
    expect(statusText({ state: "conflict" })).toBe("Not saved: changed somewhere else");
    expect(statusText({ state: "invalid", issues: ["Use at most 200 characters."] })).toBe("Not saved: Use at most 200 characters.");
    expect(statusText({ state: "error", message: "offline" })).toBe("Not saved: connection problem. Trying again…");
  });

  it("nodeTypesOf: the node types of a stored document, for refusing to edit one with blocks this editor lacks", () => {
    expect([...nodeTypesOf({ v: 1, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }, { type: "image", attrs: {} }] } })].sort()).toEqual(["doc", "image", "paragraph", "text"]);
    expect([...nodeTypesOf({})]).toEqual([]);
    expect([...nodeTypesOf(null)]).toEqual([]);
  });
});
