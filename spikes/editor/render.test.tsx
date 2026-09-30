import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENTRY_ID, renderContext, sampleDocument } from "./fixtures";
import { renderDocument, RENDERED_ELEMENTS } from "./render";

const ID = "01920000-0000-7000-8000-00000000abcd";
const html = (doc: unknown, skips: string[] = []) => renderToStaticMarkup(<>{renderDocument(doc, renderContext(skips))}</>);
const wrap = (...content: unknown[]) => ({ v: 1, doc: { type: "doc", content } });
const para = (...content: unknown[]) => ({ type: "paragraph", attrs: { id: ID }, content });
const linked = (href: string) => para({ type: "text", text: "click", marks: [{ type: "link", attrs: { href } }] });

/** Real tags and their attribute names (escaped text like `&lt;img onerror=…` is not markup). */
function inventory(markup: string) {
  const openTags = [...markup.matchAll(/<([a-z0-9]+)((?:\s+[a-zA-Z-:]+(?:="[^"]*")?)*)\s*\/?>/g)];
  // Every "<x" must be a tag the pattern understood, or the checks below would be blind to it.
  expect(openTags.length).toBe(markup.match(/<[a-zA-Z]/g)?.length ?? 0);
  const tags = new Set(openTags.map((m) => m[1]!));
  const attributes = new Set(
    openTags.flatMap((m) => [...m[2]!.matchAll(/\s([a-zA-Z-:]+)(?==|\s|$)/g)].map((a) => a[1]!.toLowerCase())),
  );
  return { tags, attributes };
}

describe("rendering the sample document", () => {
  it("renders every block with semantic, allow-listed markup", () => {
    const out = html(sampleDocument);
    expect(out).toContain("<h2>What we do</h2>");
    expect(out).toContain("<strong>fast</strong>");
    expect(out).toContain("<u><em>careful</em></u>");
    expect(out).toContain('<a href="/services">services</a>'); // entry:{id} resolved to the live path
    expect(out).toContain('<a href="mailto:hi@example.com">email us</a>');
    expect(out).toContain("<blockquote><p>Great work.</p><cite>A happy client</cite></blockquote>");
    expect(out).toContain("<ul><li><p>One</p></li><li><p>Two</p></li></ul>");
    expect(out).toContain('<ol start="1"><li><p>First</p></li></ol>');
    expect(out).toContain('<hr class="forge-divider forge-divider--line"/>');
    expect(out).toMatch(/<figure class="forge-image forge-image--wide"><img src="\/media\/team-1200.webp" srcSet="[^"]+" width="1200" height="800" alt="The team"/);
    expect(out).toContain("<figcaption>Our team</figcaption>");
    expect(out).toContain('style="grid-template-columns:2fr 1fr"');
    expect(out).toContain('<a href="/contact" class="forge-button forge-button--primary">Contact us</a>');
    expect(out).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(out).toContain('sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"');
    expect(out).toContain('<div class="forge-spacer forge-spacer--md" aria-hidden="true"></div>');
  });

  it("uses only allow-listed elements", () => {
    const { tags } = inventory(html(sampleDocument));
    expect([...tags].filter((t) => !(RENDERED_ELEMENTS as readonly string[]).includes(t))).toEqual([]);
  });

  it("renders an internal link to a deleted entry as plain text", () => {
    const out = html(wrap(linked("entry:0192f000-0000-7000-8000-00000000dead")));
    expect(out).toBe("<p>click</p>");
    expect(html(wrap(linked(`entry:${ENTRY_ID}`)))).toBe('<p><a href="/services">click</a></p>');
  });
});

/**
 * XSS corpus. The renderer is fed hostile documents directly (as if save-time
 * validation had been bypassed) and must never emit script, event handlers,
 * dangerous URLs or non-allow-listed elements.
 */
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
  ["button with a script label", wrap({ type: "button", attrs: { id: ID, v: 1, label: "<img src=x onerror=alert(1)>", href: "/" } })],
  ["button style class injection", wrap({ type: "button", attrs: { id: ID, v: 1, label: "Go", href: "/", style: 'primary" onclick="alert(1)' } })],
  ["image with onerror attr", wrap({ type: "image", attrs: { id: ID, v: 1, mediaId: "0192e000-0000-7000-8000-000000000001", onerror: "alert(1)", alt: '"><script>alert(1)</script>' } })],
  ["image with javascript: link", wrap({ type: "image", attrs: { id: ID, v: 1, mediaId: "0192e000-0000-7000-8000-000000000001", link: "javascript:alert(1)" } })],
  ["embed from an unlisted host", wrap({ type: "embed", attrs: { id: ID, v: 1, provider: "youtube", url: "https://evil.example/embed/dQw4w9WgXcQ" } })],
  ["embed with javascript: url", wrap({ type: "embed", attrs: { id: ID, v: 1, provider: "youtube", url: "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ" } })],
  ["embed with a lookalike host", wrap({ type: "embed", attrs: { id: ID, v: 1, provider: "youtube", url: "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ" } })],
  ["embed with an id carrying a payload", wrap({ type: "embed", attrs: { id: ID, v: 1, provider: "youtube", url: 'https://youtu.be/"><script>' } })],
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
];

describe("XSS corpus", () => {
  it.each(hostileDocuments)("%s", (_name, doc) => {
    const out = html(doc);
    expect(out.replace(/<[^>]*>/g, "")).not.toMatch(/<|>/); // all text is escaped
    const { tags, attributes } = inventory(out);
    expect([...tags].filter((t) => !(RENDERED_ELEMENTS as readonly string[]).includes(t))).toEqual([]);
    expect([...attributes].filter((a) => a.startsWith("on"))).toEqual([]);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/(href|src)="\s*(javascript|data|vbscript):/i);
    expect(out).not.toMatch(/(href|src)="\/\//);
    expect(out).not.toMatch(/url\(/i);
  });

  it("drops invalid nodes and reports them", () => {
    const skips: string[] = [];
    html(wrap({ type: "html", attrs: {} }, { type: "button", attrs: { id: ID, v: 1, label: "x", href: "javascript:x" } }), skips);
    expect(skips).toEqual(["html: unknown node", "button: invalid attrs"]);
  });
});
