import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BLOCK_RENDERERS, type BlockRenderContext } from "./render";

/**
 * The custom blocks' renderers (M5-5): fixed elements only, built from
 * attributes each renderer validates itself. Anything invalid renders nothing.
 * The whole-document renderer (and its XSS corpus) is M5-6's.
 */

const ID = "01920000-0000-7000-8000-000000000001";
const ENTRY = "0192f000-0000-7000-8000-000000000002";
const context: BlockRenderContext = {
  resolveEntryHref: (entryId) => (entryId === ENTRY ? "/s/acme/services" : undefined),
  blockedHosts: ["cms.forgelinetechnologies.com"],
};
const html = (type: string, attrs: unknown, children: readonly React.ReactNode[] = []) =>
  renderToStaticMarkup(<>{BLOCK_RENDERERS[type]!({ attrs, children, context })}</>);

const buttonAttrs = { id: ID, v: 1, label: "Contact us", href: "/contact", style: "primary", align: "start", newTab: false };
/** Markup (not escaped text) that would run script: a script element, a script URL in an attribute, an event handler, a CSS url(). */
const XSS = /<script|<[^>]+\s(?:href|src)="\s*(?:javascript|data|vbscript):|<[^>]+\son[a-z]+=|<[^>]+style="[^"]*url\(/i;

describe("button", () => {
  it("is a link drawn as the theme's button", () => {
    expect(html("button", buttonAttrs)).toBe('<div class="forge-button-row forge-button-row--start"><a href="/contact" class="forge-button forge-button--primary">Contact us</a></div>');
  });

  it("resolves a page of this site, and renders nothing when that page is gone", () => {
    expect(html("button", { ...buttonAttrs, href: `entry:${ENTRY}` })).toContain('href="/s/acme/services"');
    expect(html("button", { ...buttonAttrs, href: "entry:0192f000-0000-7000-8000-000000000099" })).toBe("");
  });

  it("opens a new tab without giving the page a handle on this one", () => {
    expect(html("button", { ...buttonAttrs, newTab: true, style: "secondary", align: "end" })).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it.each([
    ["a javascript: link", { href: "javascript:alert(1)" }],
    ["a data: link", { href: "data:text/html,<script>alert(1)</script>" }],
    ["a protocol-relative link", { href: "//evil.example.org" }],
    ["an unknown style (a class injection)", { style: 'primary" onclick="alert(1)' }],
    ["no text", { label: "" }],
  ])("renders nothing for %s", (_name, change) => {
    expect(html("button", { ...buttonAttrs, ...change })).toBe("");
  });

  it("escapes its text", () => {
    const out = html("button", { ...buttonAttrs, label: '<img src=x onerror="alert(1)">' });
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(out).not.toMatch(/<img/);
  });
});

describe("columns", () => {
  const attrs = { id: ID, v: 1, count: 2, ratio: "2:1", stackOnMobile: true };

  it("lays its columns out by the ratio, one below the other on phones when asked", () => {
    expect(html("columns", attrs, ["a", "b"])).toBe(
      '<div class="forge-columns forge-columns--stack" style="grid-template-columns:2fr 1fr"><div class="forge-column">a</div><div class="forge-column">b</div></div>',
    );
    expect(html("columns", { ...attrs, count: 3, ratio: "1:2:1", stackOnMobile: false }, ["a", "b", "c"])).toContain('class="forge-columns" style="grid-template-columns:1fr 2fr 1fr"');
  });

  it("renders nothing when the columns do not match `count`, or the ratio is not one of the allowed", () => {
    expect(html("columns", attrs, ["a"])).toBe("");
    expect(html("columns", attrs, ["a", "b", "c"])).toBe("");
    expect(html("columns", { ...attrs, ratio: "1fr;background:url(javascript:alert(1))" }, ["a", "b"])).toBe("");
  });
});

describe("embed", () => {
  const attrs = { id: ID, v: 1, provider: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", aspect: "16:9" };

  it("frames YouTube through its privacy player, lazily, sandboxed", () => {
    const out = html("embed", attrs);
    expect(out).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"');
    expect(out).toContain('referrerPolicy="strict-origin-when-cross-origin"');
    expect(out).toContain('title="YouTube video"');
    expect(out).toContain('class="forge-embed forge-embed--16-9"');
  });

  it("frames Vimeo with do-not-track", () => {
    expect(html("embed", { ...attrs, provider: "vimeo", url: "https://vimeo.com/76979871" })).toContain('src="https://player.vimeo.com/video/76979871?dnt=1"');
  });

  it("frames a URL-safe page as given, without the video permissions", () => {
    const out = html("embed", { ...attrs, provider: "generic", url: "https://www.openstreetmap.org/export/embed.html", aspect: "4:3" });
    expect(out).toContain('src="https://www.openstreetmap.org/export/embed.html"');
    expect(out).not.toMatch(/allow="|allowFullScreen/);
  });

  it.each([
    ["a javascript: address", { provider: "generic", url: "javascript:alert(1)" }],
    ["a private host", { provider: "generic", url: "https://localhost/" }],
    ["the app's own host", { provider: "generic", url: "https://cms.forgelinetechnologies.com/acme/site/settings" }],
    ["a YouTube address that is not YouTube's", { url: "https://evil.example.org/watch?v=dQw4w9WgXcQ" }],
    ["an unknown provider", { provider: "html", url: "https://www.openstreetmap.org/" }],
  ])("renders nothing for %s", (_name, change) => {
    expect(html("embed", { ...attrs, ...change })).toBe("");
  });
});

describe("spacer", () => {
  it("is space only, hidden from assistive technology", () => {
    expect(html("spacer", { id: ID, v: 1, size: "lg" })).toBe('<div class="forge-spacer forge-spacer--lg" aria-hidden="true"></div>');
    expect(html("spacer", { id: ID, v: 1, size: 'lg" onclick="x' })).toBe("");
  });
});

it("no renderer emits script, a javascript: URL or an event handler for hostile attributes", () => {
  const hostile = '"><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(1)">';
  for (const type of Object.keys(BLOCK_RENDERERS)) {
    for (const key of ["label", "href", "style", "align", "ratio", "url", "provider", "aspect", "size"]) {
      const out = html(type, { id: ID, v: 1, label: "x", href: "/", style: "primary", align: "start", newTab: false, count: 2, ratio: "1:1", stackOnMobile: true, provider: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", aspect: "16:9", size: "md", [key]: hostile }, ["a", "b"]);
      expect(out, `${type}.${key}`).not.toMatch(XSS);
    }
  }
});
