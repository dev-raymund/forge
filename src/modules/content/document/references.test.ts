import { describe, expect, it } from "vitest";
import { editableDocument, ENTRY_ID } from "@/blocks/fixtures";
import { referencesOf } from "./references";

/** What a document points at (M5-5), for the server to check against the site. */

const MEDIA = "0192E000-0000-7000-8000-000000000001";
const OTHER = "0192f000-0000-7000-8000-0000000000aa";

describe("referencesOf", () => {
  it("finds the entries of links and buttons, nested in columns too, and every embed", () => {
    const refs = referencesOf(editableDocument);
    expect([...refs.entryIds]).toEqual([ENTRY_ID]);
    expect(refs.mediaIds.size).toBe(0);
    expect(refs.embeds.map((embed) => embed.provider).sort()).toEqual(["generic", "youtube"]);
  });

  it("finds an image's media item and link, in lower case", () => {
    const refs = referencesOf({
      v: 1,
      doc: { type: "doc", content: [{ type: "image", attrs: { mediaId: MEDIA, link: `entry:${OTHER.toUpperCase()}` } }, { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://a.org" } }] }] }] },
    });
    expect([...refs.mediaIds]).toEqual([MEDIA.toLowerCase()]);
    expect([...refs.entryIds]).toEqual([OTHER]);
  });

  it("reads any shape without trusting it", () => {
    for (const input of [null, undefined, 1, "x", {}, { doc: null }, { doc: { content: "x" } }, { doc: { content: [null, 1, { marks: "x" }, { type: "image", attrs: { mediaId: 1 } }] } }]) {
      expect(() => referencesOf(input), JSON.stringify(input)).not.toThrow();
    }
    expect(referencesOf({ doc: { content: [{ type: "button", attrs: { href: "entry:not-a-uuid" } }] } }).entryIds.size).toBe(0);
  });
});
