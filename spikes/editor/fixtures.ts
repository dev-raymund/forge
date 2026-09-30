import type { RenderContext } from "./render";
import type { StoredDocument } from "./schema";

/** A document using all 11 V1 block types, plus marks and an internal link. */

export const MEDIA_ID = "0192e000-0000-7000-8000-000000000001";
export const ENTRY_ID = "0192f000-0000-7000-8000-000000000002";

const id = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, "0")}`;

export const sampleDocument: StoredDocument = {
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

export const renderContext = (skips: string[] = []): RenderContext => ({
  resolveMedia: (mediaId) =>
    mediaId === MEDIA_ID
      ? { src: "/media/team-1200.webp", srcSet: "/media/team-600.webp 600w, /media/team-1200.webp 1200w", width: 1200, height: 800, alt: "The team" }
      : undefined,
  resolveEntryHref: (entryId) => (entryId === ENTRY_ID ? "/services" : undefined),
  onSkip: (type, reason) => skips.push(`${type}: ${reason}`),
});
