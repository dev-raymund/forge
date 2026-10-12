import type { StoredDocument } from "@/modules/content/shared";

/**
 * Test fixtures (M5-5): a stored document using every node type the editor
 * holds (the text nodes, marks, an internal link and every editable custom
 * block), already normalized, so it round-trips through the editor unchanged.
 * Used by the unit tests only.
 */

export const ENTRY_ID = "0192f000-0000-7000-8000-000000000002";
export const fixtureId = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const id = fixtureId;

export const editableDocument: StoredDocument = {
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
          { type: "text", text: " sites. See our " },
          { type: "text", text: "services", marks: [{ type: "link", attrs: { href: `entry:${ENTRY_ID}` } }] },
          { type: "text", text: "." },
        ],
      },
      {
        type: "blockquote",
        attrs: { id: id(3), cite: null },
        content: [{ type: "paragraph", attrs: { id: id(4) }, content: [{ type: "text", text: "Great work." }] }],
      },
      {
        type: "bulletList",
        attrs: { id: id(5) },
        content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { id: id(6) }, content: [{ type: "text", text: "One" }] }] }],
      },
      {
        type: "orderedList",
        attrs: { id: id(19), start: 1 },
        content: [{ type: "listItem", content: [{ type: "paragraph", attrs: { id: id(20) }, content: [{ type: "text", text: "First" }] }] }],
      },
      { type: "horizontalRule", attrs: { id: id(7), style: "line" } },
      {
        type: "columns",
        attrs: { id: id(8), v: 1, count: 2, ratio: "2:1", stackOnMobile: true },
        content: [
          { type: "column", attrs: { id: id(9) }, content: [{ type: "paragraph", attrs: { id: id(10) }, content: [{ type: "text", text: "Left" }] }] },
          {
            type: "column",
            attrs: { id: id(11) },
            content: [
              { type: "button", attrs: { id: id(12), v: 1, label: "Contact us", href: `entry:${ENTRY_ID}`, style: "primary", align: "start", newTab: false } },
              { type: "spacer", attrs: { id: id(13), v: 1, size: "sm" } },
            ],
          },
        ],
      },
      { type: "embed", attrs: { id: id(14), v: 1, provider: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", aspect: "16:9" } },
      { type: "embed", attrs: { id: id(15), v: 1, provider: "generic", url: "https://www.openstreetmap.org/export/embed.html?layer=mapnik", aspect: "4:3" } },
      { type: "spacer", attrs: { id: id(16), v: 1, size: "lg" } },
      { type: "button", attrs: { id: id(17), v: 1, label: "Call us", href: "tel:+15550100", style: "secondary", align: "center", newTab: false } },
      { type: "paragraph", attrs: { id: id(18) }, content: [{ type: "text", text: "Thanks." }] },
    ],
  },
};
