import { describe, expect, it } from "vitest";
import {
  applyTitleTemplate, documentText, EMPTY_ENTRY_SEO, entrySeoSchema, firstWords, readEntrySeo, readSiteSeo, resolveSeo, robotsRules, serializeJsonLd, SITE_SEO_DEFAULTS,
  siteSeoSchema, sitemapXml, structuredData, type SeoPage, type SeoSite,
} from "./shared";

const BASE = "https://cms.example.com/s/harbour";
const image = (name: string) => ({ url: `https://cms.example.com/media/${name}/w1600.webp`, width: 1600, height: 900, alt: name });
const site = (extra: Partial<SeoSite> = {}): SeoSite => ({ name: "Harbour Bakery", tagline: "Fresh by the sea", baseUrl: BASE, seo: SITE_SEO_DEFAULTS, defaultOgImage: null, status: "live", ...extra });
const page = (extra: Partial<SeoPage> = {}): SeoPage => ({ kind: "entry", path: "/about", title: "About", isHome: false, contentType: "page", ...extra });
const live = { preview: false, indexingAllowed: true };
const resolve = (siteExtra: Partial<SeoSite> = {}, pageExtra: Partial<SeoPage> = {}, flags = live) => resolveSeo({ site: site(siteExtra), page: page(pageExtra), flags });

describe("resolveSeo: field by field (M8-4, D-19)", () => {
  it.each([
    ["the platform's template", {}, {}, "About · Harbour Bakery", "platform"],
    ["the site's template", { seo: { ...SITE_SEO_DEFAULTS, titleTemplate: "%site% | %title%" } }, {}, "Harbour Bakery | About", "site"],
    ["the type's template over the site's", { seo: { ...SITE_SEO_DEFAULTS, titleTemplate: "%site% | %title%" } }, { typeTitleTemplate: "%title% (journal)" }, "About (journal)", "type"],
    ["the entry's own title, as it is", { seo: { ...SITE_SEO_DEFAULTS, titleTemplate: "%site% | %title%" } }, { entrySeo: { ...EMPTY_ENTRY_SEO, title: "Our story" } }, "Our story", "entry"],
    ["the home: the site's name", {}, { isHome: true, path: "/", title: "Home" }, "Harbour Bakery", "platform"],
    ["the home with its own title", {}, { isHome: true, path: "/", entrySeo: { ...EMPTY_ENTRY_SEO, title: "Bread by the harbour" } }, "Bread by the harbour", "entry"],
    ["a list's later page", {}, { kind: "blog-index", path: "/blog/page/2", title: "Blog", pageNumber: 2 }, "Blog · Page 2 · Harbour Bakery", "platform"],
  ] as const)("title: %s", (_name, siteExtra, pageExtra, value, source) => {
    expect(resolve(siteExtra, pageExtra).title).toEqual({ value, source });
  });

  it.each([
    ["the entry's own", { entrySeo: { ...EMPTY_ENTRY_SEO, description: "Mine." }, excerpt: "Excerpt." }, { value: "Mine.", source: "entry" }],
    ["the excerpt", { excerpt: "Dark and sour.", bodyText: "Body." }, { value: "Dark and sour.", source: "derived" }],
    ["the first words of the text", { bodyText: `${"word ".repeat(50)}end` }, { value: expect.stringMatching(/^word( word)+…$/), source: "derived" }],
    ["a category's description", { kind: "term-archive", termDescription: "Loaves." }, { value: "Loaves.", source: "derived" }],
    ["the site's default", {}, { value: "Default.", source: "site" }],
  ] as const)("description: %s", (_name, pageExtra, expected) => {
    const resolved = resolve({ seo: { ...SITE_SEO_DEFAULTS, defaultDescription: "Default." } }, pageExtra as Partial<SeoPage>);
    expect(resolved.description).toEqual(expected);
    if (typeof expected.value === "string") return;
    expect(resolved.description.value.length).toBeLessThanOrEqual(160);
  });

  it("description: the home's tagline last; a page with nothing says nothing", () => {
    expect(resolve({}, { isHome: true, path: "/" }).description).toEqual({ value: "Fresh by the sea", source: "platform" });
    expect(resolve({}, {}).description).toEqual({ value: "", source: null });
  });

  it("canonical: the page's own address under the site's base, or the entry's absolute https one", () => {
    expect(resolve().canonical).toEqual({ value: `${BASE}/about`, source: "derived" });
    expect(resolve({}, { isHome: true, path: "/" }).canonical.value).toBe(BASE);
    expect(resolve({}, { kind: "blog-index", path: "/blog/page/3", pageNumber: 3 }).canonical.value).toBe(`${BASE}/blog/page/3`);
    expect(resolve({}, { entrySeo: { ...EMPTY_ENTRY_SEO, canonical: "https://elsewhere.example/about" } }).canonical).toEqual({ value: "https://elsewhere.example/about", source: "entry" });
  });

  it("social image: the entry's own, a post's featured image, the site's default; Twitter's card follows", () => {
    const all = { entryOgImage: image("own"), featuredImage: image("featured") };
    expect(resolve({ defaultOgImage: image("site") }, all).image).toEqual({ value: image("own"), source: "entry" });
    expect(resolve({ defaultOgImage: image("site") }, { featuredImage: image("featured") }).image.source).toBe("derived");
    expect(resolve({ defaultOgImage: image("site") }).image.source).toBe("site");
    const none = resolve();
    expect(none.image).toEqual({ value: null, source: null });
    expect(none.twitter.card).toBe("summary");
    expect(resolve({ defaultOgImage: image("site") }).twitter.card).toBe("summary_large_image");
  });

  it.each([
    ["live, production: index and follow", {}, {}, live, { index: true, follow: true, reasons: [] }],
    ["the entry's noindex and nofollow", {}, { entrySeo: { ...EMPTY_ENTRY_SEO, noindex: true, nofollow: true } }, live, { index: false, follow: false, reasons: ["entry"] }],
    ["the site discourages indexing", { seo: { ...SITE_SEO_DEFAULTS, discourageIndexing: true } }, {}, live, { index: false, follow: true, reasons: ["site"] }],
    ["coming soon", { status: "coming_soon" }, {}, live, { index: false, follow: false, reasons: ["coming-soon"] }],
    ["a preview", {}, {}, { preview: true, indexingAllowed: true }, { index: false, follow: false, reasons: ["preview"] }],
    ["a deployment that is not production", {}, {}, { preview: false, indexingAllowed: false }, { index: false, follow: true, reasons: ["non-production"] }],
    [
      "safety wins over the entry's choice", { status: "coming_soon", seo: { ...SITE_SEO_DEFAULTS, discourageIndexing: true } }, { entrySeo: { ...EMPTY_ENTRY_SEO, noindex: false } },
      { preview: true, indexingAllowed: false }, { index: false, follow: false, reasons: ["site", "coming-soon", "preview", "non-production"] },
    ],
  ] as const)("robots: %s", (_name, siteExtra, pageExtra, flags, expected) => {
    expect(resolve(siteExtra as Partial<SeoSite>, pageExtra as Partial<SeoPage>, flags).robots).toEqual(expected);
  });

  it("Open Graph and Twitter carry the resolved fields; a post is an article; the Search Console token is the site's", () => {
    const post = resolve({ seo: { ...SITE_SEO_DEFAULTS, searchConsoleToken: "abc_123-XYZ" } }, { contentType: "post", path: "/blog/rye", title: "Rye", excerpt: "Sour." });
    expect(post.openGraph).toEqual({ type: "article", title: "Rye · Harbour Bakery", description: "Sour.", url: `${BASE}/blog/rye`, siteName: "Harbour Bakery", image: null });
    expect(post.twitter).toMatchObject({ title: "Rye · Harbour Bakery", description: "Sour." });
    expect(post.verification).toEqual({ google: "abc_123-XYZ" });
    expect(resolve().openGraph.type).toBe("website");
    expect(resolve().verification).toBeNull();
  });
});

describe("the SEO settings' schemas", () => {
  it("an entry's: canonical an absolute https address only; plain text; an image id or none", () => {
    const ok = { ...EMPTY_ENTRY_SEO, canonical: "https://example.com/a?b=1" };
    expect(entrySeoSchema.safeParse(ok).success).toBe(true);
    for (const canonical of ["http://example.com", "javascript:alert(1)", "/about", "https://user:pw@example.com/", "https://exa mple.com", "//example.com", "ftp://x.y"]) {
      expect(entrySeoSchema.safeParse({ ...ok, canonical }).success, canonical).toBe(false);
    }
    expect(entrySeoSchema.safeParse({ ...ok, title: "x".repeat(121) }).success).toBe(false);
    expect(entrySeoSchema.safeParse({ ...ok, description: "a\u0000b" }).success).toBe(false);
    expect(entrySeoSchema.safeParse({ ...ok, ogImageId: "../x" }).success).toBe(false);
    expect(entrySeoSchema.safeParse({ ...ok, robots: "noindex" }).success).toBe(false);
  });

  it("a site's: the title template holds %title% and only known tokens; the Search Console token, or its meta tag", () => {
    const ok = { ...SITE_SEO_DEFAULTS };
    expect(siteSeoSchema.parse({ ...ok, searchConsoleToken: '<meta name="google-site-verification" content="Ab1_-x" />' }).searchConsoleToken).toBe("Ab1_-x");
    expect(siteSeoSchema.safeParse({ ...ok, searchConsoleToken: '"><script>' }).success).toBe(false);
    expect(siteSeoSchema.safeParse({ ...ok, titleTemplate: "%site% only" }).success).toBe(false);
    expect(siteSeoSchema.safeParse({ ...ok, titleTemplate: "%title% %author%" }).success).toBe(false);
    expect(siteSeoSchema.safeParse({ ...ok, titleTemplate: "%title% — %site%" }).success).toBe(true);
  });

  it("stored values are read value by value: what does not read takes the default", () => {
    expect(readSiteSeo({ titleTemplate: "no token", defaultDescription: "Hi", discourageIndexing: "yes" })).toEqual({ ...SITE_SEO_DEFAULTS, defaultDescription: "Hi" });
    expect(readEntrySeo({ canonical: "javascript:alert(1)", noindex: true })).toEqual({ ...EMPTY_ENTRY_SEO, noindex: true });
    expect(readEntrySeo(null)).toEqual(EMPTY_ENTRY_SEO);
  });

  it("templates fill their tokens and leave no stray separator; long text is cut at a word", () => {
    expect(applyTitleTemplate("%title% %sep% %site%", { title: "About", site: "Harbour" })).toBe("About · Harbour");
    expect(applyTitleTemplate("%title% %sep% %site%", { title: "", site: "Harbour" })).toBe("Harbour");
    expect(firstWords("short")).toBe("short");
    expect(firstWords("a ".repeat(200), 20)).toMatch(/^(a ?)+…$/);
  });
});

describe("structured data, the sitemap, the robots rules", () => {
  const input = (kind: "page" | "post" | "list" | "home", extra: Record<string, unknown> = {}) => ({
    site: { name: "Harbour Bakery", baseUrl: BASE, language: "en", logo: { url: "https://cms.example.com/media/logo.png", width: 320, height: 120 } },
    page: {
      kind, url: `${BASE}/blog/rye`, title: "Rye", description: "Sour.", image: null, publishedAt: "2026-10-01T09:00:00.000Z", modifiedAt: "2026-10-02T09:00:00.000Z",
      breadcrumbs: [{ name: "Harbour Bakery", url: BASE }, { name: "Blog", url: `${BASE}/blog` }, { name: "Rye", url: `${BASE}/blog/rye` }], ...extra,
    },
  });

  it("WebSite, Organization, BlogPosting or WebPage, BreadcrumbList: what the site holds and nothing more", () => {
    const post = structuredData(input("post"));
    expect(post["@graph"].map((node) => node["@type"])).toEqual(["WebSite", "Organization", "BlogPosting", "BreadcrumbList"]);
    expect(post["@graph"][2]).toMatchObject({ headline: "Rye", datePublished: "2026-10-01T09:00:00.000Z", publisher: { "@id": `${BASE}#organization` } });
    expect(post["@graph"][2]).not.toHaveProperty("author");
    expect(post["@graph"][1]).toMatchObject({ logo: { url: "https://cms.example.com/media/logo.png" } });
    expect(post["@graph"][3]).toMatchObject({ itemListElement: [{ position: 1, name: "Harbour Bakery" }, { position: 2 }, { position: 3, item: `${BASE}/blog/rye` }] });
    const home = structuredData(input("home", { breadcrumbs: [{ name: "Harbour Bakery", url: BASE }] }));
    expect(home["@graph"].map((node) => node["@type"])).toEqual(["WebSite", "Organization", "WebPage"]);
  });

  it("serialised with < > & and the line separators escaped: no value can close the script", () => {
    const hostile = structuredData(input("page", { title: "</script><script>alert(1)</script> & \u2028" }));
    const json = serializeJsonLd(hostile);
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(json).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(json)).toEqual(hostile);
  });

  it("the sitemap: one url each, escaped, with its date", () => {
    const xml = sitemapXml([{ loc: `${BASE}/a?x=1&y=<2>`, lastmod: "2026-10-01T09:00:00.000Z" }, { loc: BASE }]);
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${BASE}/a?x=1&amp;y=&lt;2&gt;</loc>\n    <lastmod>2026-10-01</lastmod>\n  </url>\n  <url>\n    <loc>${BASE}</loc>\n  </url>\n</urlset>\n`,
    );
    expect(sitemapXml([])).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n`);
  });

  it("robots: /s/ allowed, the API and previews not, each indexable site's sitemap; nothing at all off production", () => {
    expect(robotsRules({ indexingAllowed: true, origin: "https://cms.example.com/", addresses: ["harbour", "rye"] })).toEqual({
      rules: [{ userAgent: "*", allow: ["/s/", "/media/"], disallow: ["/api/", "/_forge/"] }],
      sitemap: ["https://cms.example.com/s/harbour/sitemap.xml", "https://cms.example.com/s/rye/sitemap.xml"],
    });
    expect(robotsRules({ indexingAllowed: true, origin: "https://cms.example.com", addresses: [] })).not.toHaveProperty("sitemap");
    expect(robotsRules({ indexingAllowed: false, origin: "https://cms.example.com", addresses: ["harbour"] })).toEqual({ rules: [{ userAgent: "*", disallow: ["/"] }] });
  });

  it("a document's text: its words, blocks apart, nothing else", () => {
    const doc = {
      v: 1,
      doc: { type: "doc", content: [{ type: "heading", content: [{ type: "text", text: "Rye" }] }, { type: "paragraph", content: [{ type: "text", text: "Dark " }, { type: "text", text: "and sour." }] }, { type: "image", attrs: { alt: "x" } }] },
    };
    expect(documentText(doc)).toBe("Rye Dark and sour.");
    expect(documentText(null)).toBe("");
    expect(documentText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a".repeat(5000) }] }] }).length).toBe(2000);
  });
});
