import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { editableDocument, ENTRY_ID } from "@/blocks/fixtures";
import { renderDocument, RENDERED_ELEMENTS, type DocumentRenderContext } from "./document";

/**
 * The closed renderer (M5-6; the M0-5 spike's renderer and XSS corpus, ported
 * to the block registry). It is fed hostile documents directly, as if
 * save-time validation had been bypassed, and must never emit script, event
 * handlers, dangerous URLs or elements outside its list.
 */

const ID = "01920000-0000-7000-8000-00000000abcd";
const OTHER_SITES_ENTRY = "0192f000-0000-7000-8000-00000000beef";
const context = (skips: string[] = []): DocumentRenderContext => ({
  basePath: "/s/acme",
  resolveEntryHref: (id) => (id === ENTRY_ID ? "/s/acme/services" : undefined),
  blockedHosts: ["cms.forgelinetechnologies.com"],
  onSkip: (type, reason) => skips.push(`${type}: ${reason}`),
});
const html = (doc: unknown, skips: string[] = []) => renderToStaticMarkup(<>{renderDocument(doc, context(skips))}</>);
const wrap = (...content: unknown[]) => ({ v: 1, doc: { type: "doc", content } });
const para = (...content: unknown[]) => ({ type: "paragraph", attrs: { id: ID }, content });
const linked = (href: unknown) => para({ type: "text", text: "click", marks: [{ type: "link", attrs: { href } }] });
const embed = (provider: string, url: string) => wrap({ type: "embed", attrs: { id: ID, v: 1, provider, url, aspect: "16:9" } });

/** Real tags and their attribute names (escaped text like `&lt;img onerror=…` is not markup). */
function inventory(markup: string) {
  const openTags = [...markup.matchAll(/<([a-z0-9]+)((?:\s+[a-zA-Z-:]+(?:="[^"]*")?)*)\s*\/?>/g)];
  // Every "<x" must be a tag the pattern understood, or the checks below would be blind to it.
  expect(openTags.length).toBe(markup.match(/<[a-zA-Z]/g)?.length ?? 0);
  const tags = new Set(openTags.map((m) => m[1]!));
  const attributes = new Set(openTags.flatMap((m) => [...m[2]!.matchAll(/\s([a-zA-Z-:]+)(?==|\s|$)/g)].map((a) => a[1]!.toLowerCase())));
  return { tags, attributes };
}

describe("rendering every block the editor makes", () => {
  it("semantic, allow-listed markup, with the site's addresses", () => {
    const skips: string[] = [];
    const out = html(editableDocument, skips);
    expect(skips).toEqual([]);
    expect(out).toContain("<h2>What we do</h2>");
    expect(out).toContain("<strong>fast</strong>");
    expect(out).toContain('<a href="/s/acme/services">services</a>'); // entry:{id} → the live path, with the site's base
    expect(out).toContain("<blockquote><p>Great work.</p></blockquote>");
    expect(out).toContain("<ul><li><p>One</p></li></ul>");
    expect(out).toContain("<ol><li><p>First</p></li></ol>");
    expect(out).toContain('<hr class="forge-divider forge-divider--line"/>');
    expect(out).toContain('<div class="forge-columns forge-columns--stack" style="--forge-columns:2fr 1fr"><div class="forge-column"><p>Left</p></div>');
    expect(out).toContain('<a href="/s/acme/services" class="forge-button forge-button--primary">Contact us</a>'); // a button inside a column
    expect(out).toContain('<div class="forge-spacer forge-spacer--sm" aria-hidden="true"></div>');
    expect(out).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(out).toContain('src="https://www.openstreetmap.org/export/embed.html?layer=mapnik"');
    expect(out.match(/loading="lazy"/g)).toHaveLength(2);
    expect(out.match(/sandbox="allow-scripts allow-same-origin allow-presentation allow-popups/g)).toHaveLength(2);
    expect(out).toContain('<div class="forge-button-row forge-button-row--center"><a href="tel:+15550100" class="forge-button forge-button--secondary">Call us</a></div>');
    expect(out).toContain("<p>Thanks.</p>");
  });

  it("uses only allow-listed elements", () => {
    const { tags } = inventory(html(editableDocument));
    expect([...tags].filter((tag) => !(RENDERED_ELEMENTS as readonly string[]).includes(tag))).toEqual([]);
  });

  it("marks in their stored order, the link outermost; a quote's attribution beside it", () => {
    expect(html(wrap(para({ type: "text", text: "x", marks: [{ type: "italic" }, { type: "underline" }, { type: "link", attrs: { href: "/a" } }, { type: "bold" }] })))).toBe(
      '<p><a href="/s/acme/a"><strong><u><em>x</em></u></strong></a></p>',
    );
    expect(html(wrap({ type: "blockquote", attrs: { id: ID, cite: "A client" }, content: [para({ type: "text", text: "Great" })] }))).toBe(
      '<figure class="forge-quote"><blockquote><p>Great</p></blockquote><figcaption><cite>A client</cite></figcaption></figure>',
    );
    expect(html(wrap({ type: "orderedList", attrs: { id: ID, start: 3 }, content: [{ type: "listItem", content: [para({ type: "text", text: "c" })] }] }))).toBe(
      '<ol start="3"><li><p>c</p></li></ol>',
    );
  });

  it("an internal link to anything but a live entry of this site is plain text; a button to one is not drawn", () => {
    expect(html(wrap(linked(`entry:${ENTRY_ID}`)))).toBe('<p><a href="/s/acme/services">click</a></p>');
    for (const href of [`entry:${OTHER_SITES_ENTRY}`, "entry:0192f000-0000-7000-8000-00000000dead", "entry:not-an-id"]) expect(html(wrap(linked(href))), href).toBe("<p>click</p>");
    const skips: string[] = [];
    expect(html(wrap({ type: "button", attrs: { id: ID, v: 1, label: "Go", href: `entry:${OTHER_SITES_ENTRY}`, style: "primary", align: "start", newTab: false } }), skips)).toBe("");
    expect(skips).toEqual(["button: not drawn"]);
  });

  it("an image is not drawn yet (M6-4), and says so", () => {
    const skips: string[] = [];
    const out = html(wrap(para({ type: "text", text: "a" }), { type: "image", attrs: { id: ID, v: 1, mediaId: "0192e000-0000-7000-8000-000000000001", alt: "x", caption: "Team", size: "wide", link: null } }), skips);
    expect(out).toBe("<p>a</p>");
    expect(skips).toEqual(["image: not rendered yet"]);
  });

  it("skips what is invalid or out of place, reports each, and draws the rest", () => {
    const skips: string[] = [];
    const out = html(
      wrap(
        { type: "html", attrs: {} },
        { type: "button", attrs: { id: ID, v: 1, label: "x", href: "javascript:x", style: "primary", align: "start", newTab: false } },
        { type: "column", attrs: { id: ID }, content: [para({ type: "text", text: "loose column" })] },
        { type: "listItem", content: [para({ type: "text", text: "loose item" })] },
        { type: "text", text: "loose text" },
        para({ type: "text", text: "kept" }, { type: "spacer", attrs: { id: ID, v: 1, size: "md" } }),
        { type: "bulletList", attrs: { id: ID }, content: [{ type: "paragraph", attrs: { id: ID } }, { type: "listItem", content: [para({ type: "text", text: "item" })] }] },
      ),
      skips,
    );
    expect(out).toBe("<p>kept</p><ul><li><p>item</p></li></ul>");
    expect(skips).toEqual(["html: unknown", "button: invalid", "column: unknown", "listItem: unknown", "text: unknown", "spacer: unknown", "paragraph: unknown"]);
  });

  it("columns hold columns only as columns: one nested inside is skipped; a wrong count draws none", () => {
    const column = (...content: unknown[]) => ({ type: "column", attrs: { id: ID }, content });
    const nested = { type: "columns", attrs: { id: ID, v: 1, count: 2, ratio: "1:1", stackOnMobile: true }, content: [column(para({ type: "text", text: "x" })), column(para({ type: "text", text: "y" }))] };
    const skips: string[] = [];
    const out = html(wrap({ ...nested, content: [column(nested, para({ type: "text", text: "a" })), column(para({ type: "text", text: "b" }))] }), skips);
    expect(out).toBe('<div class="forge-columns forge-columns--stack" style="--forge-columns:1fr 1fr"><div class="forge-column"><p>a</p></div><div class="forge-column"><p>b</p></div></div>');
    expect(skips).toEqual(["columns: invalid"]);
    expect(html(wrap({ ...nested, attrs: { ...nested.attrs, count: 3, ratio: "1:1:1" } }))).toBe("");
  });

  it("a document too deep or too large stops drawing at the limit instead of failing", () => {
    let deep: unknown = para({ type: "text", text: "bottom" });
    for (let i = 0; i < 2_000; i++) deep = { type: "blockquote", attrs: { id: ID, cite: null }, content: [deep] };
    const skips: string[] = [];
    expect(() => html(wrap(deep), skips)).not.toThrow();
    expect(skips).toContain("blockquote: too deep");
    const many = wrap(...Array.from({ length: 6_000 }, () => para({ type: "text", text: "p" })));
    const manySkips: string[] = [];
    expect(html(many, manySkips).match(/<p>/g)).toHaveLength(5_000);
    expect(manySkips).toEqual(["paragraph: too many"]);
  });
});

/** The spike's 31 payloads (ADR 0003), then the blocks M5-5 added and the paths M5-6 added. */
const hostileDocuments: [string, unknown][] = [
  ["script text", wrap(para({ type: "text", text: "<script>alert(1)</script><img src=x onerror=alert(1)>" }))],
  ["javascript: link", wrap(linked("javascript:alert(1)"))],
  ["mixed-case javascript: link", wrap(linked("JaVaScRiPt:alert(1)"))],
  ["whitespace-prefixed javascript: link", wrap(linked(" javascript:alert(1)"))],
  ["entity-encoded javascript: link", wrap(linked("javascript&colon;alert(1)"))],
  ["data: link", wrap(linked("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="))],
  ["vbscript: link", wrap(linked("vbscript:msgbox(1)"))],
  ["protocol-relative link", wrap(linked("//evil.example/x"))],
  ["backslash link", wrap(linked("/\\evil.example"))],
  ["unknown node with html", wrap({ type: "html", attrs: { id: ID, html: "<script>alert(1)</script>" } })],
  ["unknown node named script", wrap({ type: "script", content: [{ type: "text", text: "alert(1)" }] })],
  ["iframe node", wrap({ type: "iframe", attrs: { src: "javascript:alert(1)" } })],
  ["event handler attrs on a paragraph", wrap({ type: "paragraph", attrs: { id: ID, onclick: "alert(1)", style: "x" }, content: [{ type: "text", text: "p" }] })],
  ["heading level injection", wrap({ type: "heading", attrs: { id: ID, level: "1 onmouseover=alert(1)" }, content: [{ type: "text", text: "h" }] })],
  ["button with javascript: href", wrap({ type: "button", attrs: { id: ID, v: 1, label: "Go", href: "javascript:alert(1)" } })],
  ["button with data: href", wrap({ type: "button", attrs: { id: ID, v: 1, label: "Go", href: "data:text/html,<script>alert(1)</script>" } })],
  ["button with a script label", wrap({ type: "button", attrs: { id: ID, v: 1, label: "<img src=x onerror=alert(1)>", href: "/", style: "primary", align: "start", newTab: false } })],
  ["button style class injection", wrap({ type: "button", attrs: { id: ID, v: 1, label: "Go", href: "/", style: 'primary" onclick="alert(1)' } })],
  ["image with onerror attr", wrap({ type: "image", attrs: { id: ID, v: 1, mediaId: "0192e000-0000-7000-8000-000000000001", onerror: "alert(1)", alt: '"><script>alert(1)</script>' } })],
  ["image with javascript: link", wrap({ type: "image", attrs: { id: ID, v: 1, mediaId: "0192e000-0000-7000-8000-000000000001", link: "javascript:alert(1)" } })],
  ["embed from an unlisted host", embed("youtube", "https://evil.example/embed/dQw4w9WgXcQ")],
  ["embed with javascript: url", embed("youtube", "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ")],
  ["embed with a lookalike host", embed("youtube", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")],
  ["embed with an id carrying a payload", embed("youtube", 'https://youtu.be/"><script>')],
  ["columns ratio style injection", wrap({ type: "columns", attrs: { id: ID, v: 1, count: 2, ratio: "1:1;background:url(javascript:alert(1))" }, content: [
    { type: "column", attrs: { id: ID }, content: [para({ type: "text", text: "a" })] },
    { type: "column", attrs: { id: ID }, content: [para({ type: "text", text: "b" })] },
  ] })],
  ["spacer size class injection", wrap({ type: "spacer", attrs: { id: ID, v: 1, size: 'md" onmouseover="alert(1)' } })],
  ["mark with unknown type", wrap(para({ type: "text", text: "x", marks: [{ type: "script" }, { type: "link", attrs: { href: "javascript:alert(1)" } }] }))],
  ["prototype pollution keys", wrap(JSON.parse('{"type":"paragraph","attrs":{"id":"' + ID + '","__proto__":{"onclick":"alert(1)"}},"content":[{"type":"text","text":"p"}]}'))],
  ["quote cite with markup", wrap({ type: "blockquote", attrs: { id: ID, cite: "<script>alert(1)</script>" }, content: [para({ type: "text", text: "q" })] })],
  ["not a document at all", "<script>alert(1)</script>"],
  ["null", null],
  // M5-5's blocks and M5-6's paths.
  ["generic embed of a private host", embed("generic", "https://localhost/admin")],
  ["generic embed of an IP address", embed("generic", "https://169.254.169.254/latest/meta-data")],
  ["generic embed with credentials", embed("generic", "https://user:pass@www.openstreetmap.org/")],
  ["generic embed with a port", embed("generic", "https://www.openstreetmap.org:8443/")],
  ["generic embed of plain http", embed("generic", "http://www.openstreetmap.org/")],
  ["generic embed of Forge itself", embed("generic", "https://cms.forgelinetechnologies.com/acme/sites/bakery/settings")],
  ["generic embed of a data: page", embed("generic", "data:text/html,<script>alert(1)</script>")],
  ["embed of an unknown provider", embed("html", "https://www.openstreetmap.org/")],
  ["embed with extra frame attributes", wrap({ type: "embed", attrs: { id: ID, v: 1, provider: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", aspect: "16:9", srcdoc: "<script>alert(1)</script>", sandbox: "allow-top-navigation", onload: "alert(1)" } })],
  ["embed aspect class injection", wrap({ type: "embed", attrs: { id: ID, v: 1, provider: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", aspect: '16:9" onload="alert(1)' } })],
  ["button align class injection", wrap({ type: "button", attrs: { id: ID, v: 1, label: "Go", href: "/", style: "primary", align: 'start" onclick="alert(1)', newTab: false } })],
  ["button opening a new tab with a javascript: link", wrap({ type: "button", attrs: { id: ID, v: 1, label: "Go", href: "javascript:alert(1)", style: "primary", align: "start", newTab: true } })],
  ["divider style class injection", wrap({ type: "horizontalRule", attrs: { id: ID, style: 'line" onclick="alert(1)' } })],
  ["ordered list start injection", wrap({ type: "orderedList", attrs: { id: ID, start: '1" onclick="alert(1)' }, content: [{ type: "listItem", content: [para({ type: "text", text: "x" })] }] })],
  ["link mark with an object as its address", wrap(linked({ toString: "javascript:alert(1)" }))],
  ["link mark with no attributes", wrap(para({ type: "text", text: "x", marks: [{ type: "link" }] }))],
  ["marks named after prototype keys", wrap(para({ type: "text", text: "x", marks: [{ type: "__proto__" }, { type: "constructor" }, { type: "toString" }] }))],
  ["nodes named after prototype keys", wrap({ type: "__proto__" }, { type: "constructor" }, { type: "hasOwnProperty" }, { type: "toString" })],
  ["text that is not a string", wrap(para({ type: "text", text: { __html: "<script>alert(1)</script>" } }))],
  ["a document whose doc is a string", { v: 1, doc: "<script>alert(1)</script>" }],
  ["a column with a nested columns of script", wrap({ type: "columns", attrs: { id: ID, v: 1, count: 2, ratio: "1:1", stackOnMobile: true }, content: [
    { type: "column", attrs: { id: ID }, content: [{ type: "columns", attrs: { id: ID, v: 1, count: 2, ratio: "1:1" }, content: [{ type: "script" }] }] },
    { type: "column", attrs: { id: ID }, content: [{ type: "html", attrs: { html: "<script>" } }] },
  ] })],
];

describe("XSS corpus", () => {
  it.each(hostileDocuments)("%s", (_name, doc) => {
    const out = html(doc);
    expect(out.replace(/<[^>]*>/g, "")).not.toMatch(/<|>/); // all text is escaped
    const { tags, attributes } = inventory(out);
    expect([...tags].filter((tag) => !(RENDERED_ELEMENTS as readonly string[]).includes(tag))).toEqual([]);
    expect([...attributes].filter((attribute) => attribute.startsWith("on") || attribute === "srcdoc")).toEqual([]);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/(href|src)="\s*(javascript|data|vbscript):/i);
    expect(out).not.toMatch(/(href|src)="\/\//);
    expect(out).not.toMatch(/(href|src)="https?:\/\/(localhost|169\.254|cms\.forgelinetechnologies\.com|[^"]*@)/i);
    expect(out).not.toMatch(/url\(/i);
    expect(out).not.toMatch(/allow-top-navigation/);
  });

  it("covers the spike's 31 payloads and more", () => {
    expect(hostileDocuments.length).toBeGreaterThan(31);
  });
});
