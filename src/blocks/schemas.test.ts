import { describe, expect, it } from "vitest";
import { parseDocument } from "@/modules/content/shared";
import { embedSrc, providerOf } from "./embed/schema";
import { button, column, columns, embed, image, spacer } from "./schemas";

/** Each custom block's attributes (M5-5): what is valid, and what is refused. */

const ID = "01920000-0000-7000-8000-000000000001";
const ENTRY = "0192f000-0000-7000-8000-000000000002";
const ok = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: object) => schema.safeParse({ id: ID, ...value }).success;

describe("button", () => {
  const base = { v: 1, label: "Contact us", href: "/contact", style: "primary", align: "start", newTab: false };

  it.each([
    ["a site path", { href: "/contact" }],
    ["https", { href: "https://example.org/x?y=1" }],
    ["http", { href: "http://example.org/" }],
    ["mailto", { href: "mailto:hi@example.org" }],
    ["tel", { href: "tel:+15550100" }],
    ["a page of this site", { href: `entry:${ENTRY}` }],
    ["the secondary style, centred, in a new tab", { style: "secondary", align: "center", newTab: true }],
    ["80 characters of text", { label: "x".repeat(80) }],
  ])("accepts %s", (_name, change) => expect(ok(button.attrs, { ...base, ...change })).toBe(true));

  it.each([
    ["javascript:", { href: "javascript:alert(1)" }],
    ["JaVaScRiPt: with spaces", { href: " JaVaScRiPt:alert(1)" }],
    ["data:", { href: "data:text/html,<script>alert(1)</script>" }],
    ["vbscript:", { href: "vbscript:msgbox(1)" }],
    ["a protocol-relative address", { href: "//evil.example.org/" }],
    ["a backslash path", { href: "/\\evil.example.org" }],
    ["an entry link that is not a uuid", { href: "entry:../../admin" }],
    ["an empty link", { href: "" }],
    ["a link over 2,048 characters", { href: `/${"x".repeat(2048)}` }],
    ["empty text", { label: "   " }],
    ["81 characters of text", { label: "x".repeat(81) }],
    ["another style", { style: "danger" }],
    ["another alignment", { align: "justify" }],
    ["newTab as a string", { newTab: "true" }],
    ["another version", { v: 2 }],
    ["no id", { id: undefined }],
    ["an id that is not a uuid", { id: "1" }],
  ])("refuses %s", (_name, change) => expect(ok(button.attrs, { ...base, ...change })).toBe(false));

  it("trims the text and the link", () => {
    expect(button.attrs.parse({ id: ID, ...base, label: "  Go  ", href: " /x " })).toMatchObject({ label: "Go", href: "/x" });
  });
});

describe("columns", () => {
  it.each([
    [2, "1:1"], [2, "2:1"], [2, "1:2"], [3, "1:1:1"], [3, "2:1:1"], [3, "1:2:1"], [3, "1:1:2"],
  ])("accepts %i columns at %s", (count, ratio) => expect(ok(columns.attrs, { v: 1, count, ratio, stackOnMobile: true })).toBe(true));

  it.each([
    ["1 column", { count: 1, ratio: "1:1" }],
    ["4 columns", { count: 4, ratio: "1:1:1" }],
    ["a ratio for another count", { count: 2, ratio: "1:1:1" }],
    ["a ratio for another count (3)", { count: 3, ratio: "2:1" }],
    ["an unknown ratio", { count: 2, ratio: "9:1" }],
    ["a CSS value as the ratio", { count: 2, ratio: "1fr 1fr; background:url(x)" }],
    ["stackOnMobile as a string", { count: 2, ratio: "1:1", stackOnMobile: "yes" }],
  ])("refuses %s", (_name, change) => expect(ok(columns.attrs, { v: 1, stackOnMobile: true, ...change })).toBe(false));

  it("a column carries only its id", () => {
    expect(column.attrs.parse({ id: ID, width: "50%" })).toEqual({ id: ID });
  });

  const col = (n: number, content: unknown[] = [{ type: "paragraph", attrs: { id: `01920000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}` } }]) => ({
    type: "column",
    attrs: { id: `01920000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}` },
    content,
  });
  const layout = (count: number, ratio: string, children: unknown[]) => ({ v: 1, doc: { type: "doc", content: [{ type: "columns", attrs: { id: ID, v: 1, count, ratio, stackOnMobile: true }, content: children }] } });

  it("a document holds 2 or 3 columns, as many as `count` says", () => {
    expect(parseDocument(layout(2, "1:1", [col(1), col(2)])).ok).toBe(true);
    expect(parseDocument(layout(3, "1:1:1", [col(1), col(2), col(3)])).ok).toBe(true);
    expect(parseDocument(layout(2, "1:1", [col(1)])).ok).toBe(false);
    expect(parseDocument(layout(2, "1:1", [col(1), col(2), col(3)])).ok).toBe(false);
    expect(parseDocument(layout(3, "1:1:1", [col(1), col(2), col(3), col(4)])).ok).toBe(false);
  });

  it("columns never hold columns, and a column is never empty", () => {
    const inner = { type: "columns", attrs: { id: "01920000-0000-7000-8000-000000000999", v: 1, count: 2, ratio: "1:1", stackOnMobile: true }, content: [col(5), col(6)] };
    expect(parseDocument(layout(2, "1:1", [col(1, [inner]), col(2)])).ok).toBe(false);
    expect(parseDocument(layout(2, "1:1", [col(1, []), col(2)])).ok).toBe(false);
  });
});

describe("embed", () => {
  const youtube = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  it.each([
    ["youtube", youtube, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["youtube", "https://youtu.be/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["youtube", "https://m.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["youtube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["vimeo", "https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871?dnt=1"],
    ["generic", "https://www.openstreetmap.org/export/embed.html?layer=mapnik", "https://www.openstreetmap.org/export/embed.html?layer=mapnik"],
  ])("%s %s is framed as %s", (provider, url, src) => {
    expect(embedSrc(provider, url)).toBe(src);
    expect(providerOf(url)).toBe(provider);
    expect(ok(embed.attrs, { v: 1, provider, url, aspect: "16:9" })).toBe(true);
  });

  it.each([
    ["youtube", "https://www.youtube.com/watch?v=short"],
    ["youtube", "https://evil.example.org/watch?v=dQw4w9WgXcQ"],
    ["youtube", "http://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["youtube", "https://www.youtube.com.evil.org/watch?v=dQw4w9WgXcQ"],
    ["vimeo", "https://vimeo.com/channels/staffpicks"],
    ["vimeo", "https://player.vimeo.com.evil.org/video/76979871"],
    ["generic", "javascript:alert(1)"],
    ["generic", "data:text/html,<script>alert(1)</script>"],
    ["generic", "http://maps.openstreetmap.org/"],
    ["generic", "https://localhost/"],
    ["generic", "https://127.0.0.1/"],
    ["generic", "https://[::1]/"],
    ["generic", "https://intranet.corp/"],
    ["generic", "https://user:pass@www.openstreetmap.org/"],
    ["generic", "https://www.openstreetmap.org:8443/"],
    ["generic", ""],
    ["tiktok", "https://www.tiktok.com/@a/video/1"],
    ["html", "<iframe src=x>"],
  ])("refuses %s %s", (provider, url) => {
    expect(ok(embed.attrs, { v: 1, provider, url, aspect: "16:9" })).toBe(false);
  });

  it("refuses a generic embed of a blocked host (the server passes the app's own)", () => {
    expect(embedSrc("generic", "https://cms.forgelinetechnologies.com/x", { blockedHosts: ["cms.forgelinetechnologies.com"] })).toBeNull();
    expect(embedSrc("generic", "https://a.cms.forgelinetechnologies.com/x", { blockedHosts: ["cms.forgelinetechnologies.com"] })).toBeNull();
    expect(embedSrc("generic", "https://forgelinetechnologies.com/x", { blockedHosts: ["cms.forgelinetechnologies.com"] })).not.toBeNull();
  });

  it("refuses another shape, and a YouTube address stored as generic is still framed as given (the editor sets the provider from the address)", () => {
    expect(ok(embed.attrs, { v: 1, provider: "youtube", url: youtube, aspect: "21:9" })).toBe(false);
    expect(providerOf("https://www.openstreetmap.org/")).toBe("generic");
  });
});

describe("spacer", () => {
  it.each(["sm", "md", "lg", "xl"])("accepts %s", (size) => expect(ok(spacer.attrs, { v: 1, size })).toBe(true));
  it.each(["xs", "huge", "100px", 3])("refuses %s", (size) => expect(ok(spacer.attrs, { v: 1, size })).toBe(false));
});

describe("image (stored and validated now; edited from M6-4)", () => {
  const base = { v: 1, mediaId: "0192e000-0000-7000-8000-000000000001", alt: "A team photo", caption: null, size: "wide", link: null };
  it("accepts a media id, never a URL", () => {
    expect(ok(image.attrs, base)).toBe(true);
    expect(ok(image.attrs, { ...base, mediaId: "https://evil.example.org/x.png" })).toBe(false);
    expect(ok(image.attrs, { ...base, src: "https://evil.example.org/x.png" })).toBe(true); // an attribute it does not define is dropped, never stored
    expect(image.attrs.parse({ id: ID, ...base, src: "x" })).not.toHaveProperty("src");
    expect(ok(image.attrs, { ...base, link: "javascript:alert(1)" })).toBe(false);
  });
});
