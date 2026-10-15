// @vitest-environment happy-dom
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { button, columns, embed, image, spacer } from "@/blocks/schemas";
import { parseDocument } from "@/modules/content/shared";
import { editorExtensions } from "../extensions";
import { errorsFor, fieldsOf } from "./fields";
import { currentBlock, PropertiesPanel } from "./properties-panel";

/**
 * The properties panel (M5-5): fields generated from each block's schema, and
 * a change reaches the document only when the whole block is valid.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("fields from a block's schema", () => {
  it("button: its text (at most 80), a link field, two choices and a switch; never the id or `v`", () => {
    expect(fieldsOf(button.attrs)).toEqual([
      { key: "label", kind: "text", label: "Text", description: undefined, maxLength: 80, widget: undefined },
      { key: "href", kind: "text", label: "Link", description: undefined, maxLength: 2048, widget: "link" },
      { key: "style", kind: "select", label: "Style", description: undefined, options: [{ value: "primary", label: "Primary" }, { value: "secondary", label: "Secondary" }] },
      { key: "align", kind: "select", label: "Alignment", description: undefined, options: [{ value: "start", label: "Left" }, { value: "center", label: "Centre" }, { value: "end", label: "Right" }] },
      { key: "newTab", kind: "checkbox", label: "Open in a new tab", description: undefined },
    ]);
  });

  it("columns: the widths and the phone layout, not `count` (columns are added and removed as columns)", () => {
    expect(fieldsOf(columns.attrs).map((field) => [field.key, field.kind])).toEqual([["ratio", "select"], ["stackOnMobile", "checkbox"]]);
  });

  it("embed: the address and the shape, not the provider (it follows the address)", () => {
    expect(fieldsOf(embed.attrs).map((field) => [field.key, field.kind, field.label])).toEqual([["url", "text", "Address"], ["aspect", "select", "Shape"]]);
  });

  it("spacer: its height", () => {
    expect(fieldsOf(spacer.attrs)).toEqual([{ key: "size", kind: "select", label: "Height", description: undefined, options: [
      { value: "sm", label: "Small" }, { value: "md", label: "Medium" }, { value: "lg", label: "Large" }, { value: "xl", label: "Extra large" },
    ] }]);
  });

  it("image (M6-4): the image (chosen with the picker, never typed), alt text, caption, size, link", () => {
    expect(fieldsOf(image.attrs)).toEqual([
      { key: "mediaId", kind: "text", label: "Image", description: undefined, maxLength: undefined, widget: "media" },
      {
        key: "alt", kind: "text", label: "Alternative text", maxLength: 500, widget: undefined,
        description: "What the image shows, for people who cannot see it. Empty: the image's own, from the media library.",
      },
      { key: "caption", kind: "text", label: "Caption", description: undefined, maxLength: 1000, widget: undefined },
      { key: "size", kind: "select", label: "Size", description: undefined, options: [{ value: "content", label: "Text width" }, { value: "wide", label: "Wide" }, { value: "full", label: "Full width" }] },
      { key: "link", kind: "text", label: "Link", description: undefined, maxLength: 2048, widget: "link" },
    ]);
  });

  it("errors are given per field", () => {
    const result = button.attrs.safeParse({ id: "01920000-0000-7000-8000-000000000001", v: 1, label: "", href: "javascript:x", style: "primary", align: "start", newTab: false });
    const error = result.success ? undefined : result.error;
    expect(errorsFor(error, "label")).toEqual(["Enter the button's text."]);
    expect(errorsFor(error, "href")).toEqual(["Use an https:// address, mailto:, tel:, a path like /contact, or a page of this site."]);
    expect(errorsFor(error, "style")).toEqual([]);
  });
});

describe("the panel on a real editor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: Editor;

  async function makeEditor(content: JSONContent) {
    let created!: () => void;
    const ready = new Promise<void>((resolve) => (created = resolve));
    editor = new Editor({ element: document.createElement("div"), extensions: editorExtensions({ nodeViews: false }), content, onCreate: () => created() });
    await ready;
  }
  /** Renders the panel for the current selection, as the entry editor does after every transaction. */
  async function render() {
    const block = currentBlock(editor);
    await act(async () => root.render(block ? <PropertiesPanel key={`${block.type}:${String(block.attrs.id)}`} editor={editor} block={block} orgSlug="acme" siteSlug="bakery" /> : null));
  }
  function select(index: number) {
    let at = 0;
    for (let i = 0; i < index; i++) at += editor.state.doc.child(i).nodeSize;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
  }
  const field = (label: string) => {
    const target = [...container.querySelectorAll("label")].find((l) => l.textContent?.trim() === label);
    return (target?.htmlFor ? container.querySelector(`#${CSS.escape(target.htmlFor)}`) : target?.querySelector("input")) as HTMLInputElement | HTMLSelectElement;
  };
  async function type(label: string, value: string) {
    const input = field(label);
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
    await render();
  }
  const attrsAt = (index: number) => editor.state.doc.child(index).attrs;
  const alerts = () => [...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent);

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    editor?.destroy();
  });

  it("is shown for a selected custom block only", async () => {
    await makeEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }, { type: "button", attrs: { ...button.defaults } }] });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)));
    await render();
    expect(container.querySelector('[data-testid="properties-panel"]')).toBeNull();
    select(1);
    await render();
    expect(container.querySelector('[aria-label="Block settings"] h2')?.textContent).toBe("Button");
  });

  it("applies a valid change, and keeps an invalid one in the field (with why) without touching the block", async () => {
    await makeEditor({ type: "doc", content: [{ type: "button", attrs: { ...button.defaults } }] });
    select(0);
    await render();
    await type("Text", "Book a table");
    expect(attrsAt(0)).toMatchObject({ label: "Book a table" });

    await type("Link", "javascript:alert(1)");
    expect(attrsAt(0)).toMatchObject({ href: "/" });
    expect(field("Link").value).toBe("javascript:alert(1)");
    expect(field("Link").getAttribute("aria-invalid")).toBe("true");
    expect(alerts()).toEqual(["Use an https:// address, mailto:, tel:, a path like /contact, or a page of this site."]);

    await type("Text", "   ");
    expect(attrsAt(0)).toMatchObject({ label: "Book a table", href: "/" }); // nothing half-applied
    expect(alerts()).toHaveLength(2);

    await type("Link", "/book");
    await type("Text", "Book now");
    expect(attrsAt(0)).toMatchObject({ label: "Book now", href: "/book" });
    expect(alerts()).toEqual([]);
    await type("Style", "secondary");
    expect(attrsAt(0)).toMatchObject({ style: "secondary" });
    expect(parseDocument({ v: 1, doc: editor.getJSON() }).ok).toBe(true);
  });

  it("shows the document as it is after an undo, and a later change does not bring the undone value back", async () => {
    await makeEditor({ type: "doc", content: [{ type: "button", attrs: { ...button.defaults } }] });
    select(0);
    await render();
    await type("Text", "Changed");
    editor.commands.undo();
    select(0);
    await render();
    expect(field("Text").value).toBe("Button");
    await type("Alignment", "center");
    expect(attrsAt(0)).toMatchObject({ label: "Button", align: "center" });
  });

  it("an image (M6-4): its alt text, caption, size and link; an emptied field is no value; the image itself is chosen, not typed", async () => {
    const mediaId = "0192e000-0000-7000-8000-000000000001";
    await makeEditor({ type: "doc", content: [{ type: "image", attrs: { ...image.defaults, mediaId } }] });
    select(0);
    await render();
    expect(container.querySelector('[aria-label="Block settings"] h2')?.textContent).toBe("Image");
    expect(container.querySelector('[data-testid="media-field"]')?.textContent).toContain("Choose another image");
    expect(field("Image")).toBeUndefined(); // no text field for the media id

    await type("Alternative text", "The team at work");
    await type("Caption", "Spring 2026");
    await type("Size", "full");
    expect(attrsAt(0)).toMatchObject({ mediaId, alt: "The team at work", caption: "Spring 2026", size: "full", link: null });

    await type("Alternative text", "");
    expect(attrsAt(0)).toMatchObject({ alt: null }); // the image's own alt text again, not "decorative"

    await type("Link", "javascript:alert(1)");
    expect(attrsAt(0)).toMatchObject({ link: null });
    expect(alerts()).toHaveLength(1);
    await type("Link", "/menu");
    await type("Link", "");
    expect(attrsAt(0)).toMatchObject({ link: null, mediaId });
    expect(attrsAt(0).id).toMatch(/^[0-9a-f-]{36}$/);
    expect(parseDocument({ v: 1, doc: editor.getJSON() }).ok).toBe(true);
  });

  it("an embed's provider follows its address: a YouTube address gets the privacy player", async () => {
    await makeEditor({ type: "doc", content: [{ type: "embed", attrs: { ...embed.defaults, provider: "generic", url: "https://www.openstreetmap.org/" } }] });
    select(0);
    await render();
    await type("Address", "https://youtu.be/dQw4w9WgXcQ");
    expect(attrsAt(0)).toMatchObject({ provider: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" });
    await type("Address", "https://localhost/");
    expect(attrsAt(0)).toMatchObject({ provider: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" });
    expect(alerts()).toHaveLength(1);
  });

  it("columns: widths for this number of columns; a column is added, and the last removed only when it is empty", async () => {
    const col = (text?: string) => ({ type: "column", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }] });
    await makeEditor({ type: "doc", content: [{ type: "columns", attrs: { ...columns.defaults }, content: [col("a"), col("b")] }] });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3))); // in the first column
    await render();
    const options = () => [...(field("Widths") as HTMLSelectElement).options].map((option) => option.value);
    expect(options()).toEqual(["1:1", "2:1", "1:2"]);
    await type("Widths", "2:1");
    expect(attrsAt(0)).toMatchObject({ count: 2, ratio: "2:1" });

    const click = async (name: string) => {
      const target = [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
      expect(target.disabled, name).toBe(false);
      await act(async () => target.click());
      await render();
    };
    const remove = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Remove the last column")!;
    expect(remove().disabled).toBe(true); // two is the least
    await click("Add a column");
    expect(editor.state.doc.child(0).childCount).toBe(3);
    expect(attrsAt(0)).toMatchObject({ count: 3, ratio: "1:1:1" });
    expect(options()).toEqual(["1:1:1", "2:1:1", "1:2:1", "1:1:2"]);
    expect(remove().disabled).toBe(false);
    await click("Remove the last column");
    expect(attrsAt(0)).toMatchObject({ count: 2, ratio: "1:1" });

    // A third column with something in it is not removed from here.
    await click("Add a column");
    const end = editor.state.doc.child(0).nodeSize - 3;
    editor.chain().setTextSelection(end).insertContent("c").run();
    await render();
    expect(remove().disabled).toBe(true);
    expect(container.textContent).toContain("Empty the last column to remove it.");
    expect(parseDocument({ v: 1, doc: editor.getJSON() }).ok).toBe(true);
  });
});
