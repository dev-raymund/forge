import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { editableDocument, ENTRY_ID, fixtureId } from "@/blocks/fixtures";

vi.mock("@/platform/config/env", () => ({ env: () => ({ APP_ORIGIN: "https://cms.forgelinetechnologies.com" }) }));

import type { PublicPage } from "../public-page";
import type { PublicSite } from "../queries";
import { PublicPageView, publicPageTitle } from "./public-page";
import { EMPTY_ENTRY_SEO, SITE_SEO_DEFAULTS } from "@/modules/seo/shared";

/**
 * What a live site's page hands its theme (M5-6): the template the page asked for, public addresses with the
 * site's base, dates in the site's language and zone, and nothing private.
 */

const site: PublicSite = {
  id: "0199a000-0000-7000-8000-0000000000a1",
  orgId: "0199a000-0000-7000-8000-0000000000b2",
  name: "Acme <Bakery>",
  tagline: "Bread & more",
  status: "live",
  language: "en",
  timezone: "Asia/Manila",
  themeKey: "studio",
  themeSettings: {},
  social: [],
  analytics: { ga4MeasurementId: "G-ABC1234567", plausibleDomain: "acme.example.org" },
  reading: { blogPath: "news", postsPerPage: 2 },
  imagery: { logo: null, favicon: null }, seo: SITE_SEO_DEFAULTS, defaultOgImage: null, notFoundEntryId: null,
};
const locator = { kind: "address", address: "acme" } as const;
const TERM_SLUG = "bread";
const draw = (page: PublicPage, at: PublicSite = site) => renderToStaticMarkup(<PublicPageView page={page} site={at} locator={locator} />);
const page = (template: string | null, content: unknown = editableDocument, path = "/about"): PublicPage => ({
  kind: "entry",
  entry: { type: "page", title: "About <us>", path, template, content, publishedAt: "2026-09-30T23:30:00.000Z", terms: [], images: {}, featuredImage: null, excerpt: "", seo: EMPTY_ENTRY_SEO, ogImage: null, modifiedAt: null },
  links: { [ENTRY_ID]: "/services" },
});

describe("a published page", () => {
  it("its document, with `entry:` links to live entries resolved under the site's base", () => {
    const html = draw(page(null));
    expect(html).toMatch(/<h1>About &lt;us&gt;<\/h1>/);
    expect(html).toContain('<a href="/s/acme/services">services</a>');
    expect(html).toContain('<a href="/s/acme/services" class="forge-button forge-button--primary">Contact us</a>');
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
  });

  it("the template it asked for: default, full width, landing; an unknown one is the default", () => {
    expect(draw(page(null))).toContain('<article class="studio-page">');
    expect(draw(page("default"))).toContain('<article class="studio-page">');
    expect(draw(page("full-width"))).toContain("studio-page--wide");
    expect(draw(page("landing"))).toContain("studio-page--landing");
    expect(draw(page("retired-template"))).toContain('<article class="studio-page">');
    // Journal draws each with a template of its own (M8-2).
    expect(draw(page("full-width"), { ...site, themeKey: "journal" })).toContain('<article class="journal-page journal-page--full">');
    expect(draw(page("landing"), { ...site, themeKey: "journal" })).toContain('<article class="journal-page journal-page--landing">');
    expect(draw(page(null), { ...site, themeKey: "journal" })).toContain('<article class="journal-page">');
  });

  it("a generic embed of Forge's own host is never framed, whatever the document says", () => {
    const content = { v: 1, doc: { type: "doc", content: [{ type: "embed", attrs: { id: ENTRY_ID, v: 1, provider: "generic", url: "https://cms.forgelinetechnologies.com/x", aspect: "16:9" } }] } };
    expect(draw(page(null, content))).not.toContain("<iframe");
  });
});

describe("a published post, the blog and its archives", () => {
  const post: PublicPage = {
    kind: "entry",
    entry: {
      type: "post", title: "Rye season", path: "/news/rye-season", template: null, content: editableDocument, publishedAt: "2026-09-30T23:30:00.000Z",
      terms: [{ taxonomy: "category", name: "Bread", slug: TERM_SLUG, description: "" }, { taxonomy: "tag", name: "Rye", slug: "rye", description: "" }],
      images: {},
      featuredImage: null, excerpt: "", seo: EMPTY_ENTRY_SEO, ogImage: null, modifiedAt: null,
    },
    links: {},
  };

  it("a post: its date in the site's zone, its categories and tags under the blog's path", () => {
    const html = draw(post);
    expect(html).toContain('<time dateTime="2026-09-30T23:30:00.000Z">October 1, 2026</time>'); // Manila is ahead of UTC
    expect(html).toContain('<a href="/s/acme/news/category/bread">Bread</a>');
    expect(html).toContain('<a href="/s/acme/news/tag/rye">Rye</a>');
    expect(html).toContain('<a href="/s/acme/news">Blog</a>');
    expect(html).toContain("<p>Left</p>"); // the content, with its internal links unresolved here: plain text
    expect(html).toContain("See our services.</p>");
    expect(html).not.toContain(`entry:${ENTRY_ID}`);
  });

  it("the blog's index and a term's archive: posts linked to their stored paths, pages linked both ways", () => {
    const posts = [{ title: "Rye season", path: "/blog/rye-season", excerpt: "Dark & sour", publishedAt: "2026-09-01T00:00:00.000Z" }];
    const index = draw({ kind: "blog-index", page: 2, pages: 3, posts });
    expect(index).toContain('<a href="/s/acme/blog/rye-season">Rye season</a>'); // published before the blog moved to /news: its own path
    expect(index).toContain('href="/s/acme/news" rel="prev"');
    expect(index).toContain('href="/s/acme/news/page/3" rel="next"');
    const archive = draw({ kind: "term-archive", taxonomy: "category", term: { name: "Bread", slug: TERM_SLUG, description: "Loaves" }, page: 1, pages: 2, posts });
    expect(archive).toMatch(/<h1 id="archive-title">Bread<\/h1>/);
    expect(archive).toContain('href="/s/acme/news/category/bread/page/2" rel="next"');
    expect(archive).not.toContain('rel="prev"');
  });

  it("titles: the site's name for its home; otherwise the page, its page number, then the site", () => {
    expect(publicPageTitle({ kind: "site-home" }, site)).toBe("Acme <Bakery>");
    expect(publicPageTitle(page(null, editableDocument, "/"), site)).toBe("Acme <Bakery>");
    expect(publicPageTitle(page(null), site)).toBe("About <us> · Acme <Bakery>");
    expect(publicPageTitle({ kind: "blog-index", page: 1, pages: 1, posts: [] }, site)).toBe("Blog · Acme <Bakery>");
    expect(publicPageTitle({ kind: "term-archive", taxonomy: "tag", term: { name: "Rye", slug: "rye", description: "" }, page: 3, pages: 3, posts: [] }, site)).toBe("Rye · Page 3 · Acme <Bakery>");
    expect(publicPageTitle(null, site)).toBe("Page not found · Acme <Bakery>");
  });
});

describe("what a public page never holds", () => {
  it("no ids of the site, its organization or its entries; no analytics; no stored link syntax", () => {
    const pages: PublicPage[] = [
      { kind: "site-home" },
      page(null),
      page("landing"),
      { kind: "blog-index", page: 1, pages: 1, posts: [{ title: "A", path: "/news/a", excerpt: "", publishedAt: null }] },
    ];
    for (const shown of pages) {
      const html = draw(shown);
      for (const secret of [site.id, site.orgId, ENTRY_ID, "entry:", "G-ABC1234567", "acme.example.org", "googletagmanager", "plausible", "live", "Asia/Manila"]) {
        expect(html, `${shown.kind}: ${secret}`).not.toContain(secret);
      }
    }
  });

  it("a live site without a published Home page: its name and tagline, as text", () => {
    const html = draw({ kind: "site-home" });
    expect(html).toMatch(/<h1>Acme &lt;Bakery&gt;<\/h1>/);
    expect(html).toContain("<p>Bread &amp; more</p>");
  });
});

describe("images (M6-4)", () => {
  const MEDIA = "0199a000-0000-7000-8000-0000000000c3";
  const GONE = "0199a000-0000-7000-8000-0000000000c4";
  const url = (key: string) => `/media/org/o/site/s/2026/10/${MEDIA}/${key}.webp`;
  const photo = {
    alt: "A <loaf> & crumbs", width: 3000, height: 2000,
    sources: [{ url: url("w800"), width: 800, height: 533 }, { url: url("w1600"), width: 1600, height: 1067 }],
  };
  const block = (attrs: Record<string, unknown>) => ({ type: "image", attrs: { id: ENTRY_ID, v: 1, size: "content", alt: null, caption: null, link: null, ...attrs } });
  const withImages = (content: unknown[], images: Record<string, typeof photo> = { [MEDIA]: photo }): PublicPage => {
    const shown = page(null, { v: 1, doc: { type: "doc", content } });
    if (shown.kind !== "entry") throw new Error("an entry");
    return { ...shown, entry: { ...shown.entry, images } };
  };

  it("an image block: a figure, every stored width in srcset, its intrinsic size, the image's alt text, a caption", () => {
    const html = draw(withImages([block({ mediaId: MEDIA, caption: "Fresh <today>" })]));
    expect(html).toContain('<figure class="forge-image forge-image--content">');
    expect(html).toContain(`srcSet="${url("w800")} 800w, ${url("w1600")} 1600w"`);
    expect(html).toContain(`src="${url("w800")}"`);
    expect(html).toContain('width="3000" height="2000"');
    expect(html).toContain('alt="A &lt;loaf&gt; &amp; crumbs"');
    expect(html).toContain('sizes="(min-width: 48rem) 48rem, 100vw"');
    expect(html).toContain("<figcaption>Fresh &lt;today&gt;</figcaption>");
    expect(html).toContain('loading="lazy"');
  });

  it("the block's own alt text wins, empty included (a decorative image); its size; its link resolved under the site's base", () => {
    expect(draw(withImages([block({ mediaId: MEDIA, alt: "The bakery" })]))).toContain('alt="The bakery"');
    expect(draw(withImages([block({ mediaId: MEDIA, alt: "" })]))).toContain('alt=""');
    expect(draw(withImages([block({ mediaId: MEDIA, size: "full" })]))).toContain('<figure class="forge-image forge-image--full">');
    const linked = draw(withImages([block({ mediaId: MEDIA, link: `entry:${ENTRY_ID}` })]));
    expect(linked).toContain('<a href="/s/acme/services"><img');
  });

  it("an image the page does not have (missing, trashed, another site's, a PDF): nothing at all, the rest of the page drawn", () => {
    const paragraph = (n: number, text: string) => ({ type: "paragraph", attrs: { id: fixtureId(n) }, content: [{ type: "text", text }] });
    const html = draw(withImages([paragraph(1, "Before"), block({ mediaId: GONE, caption: "Lost" }), paragraph(2, "After")]));
    expect(html).not.toContain("<figure");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Lost");
    expect(html).toMatch(/<p>Before<\/p><p>After<\/p>/);
  });

  it("a post's featured image, in Studio and in Journal: above the content, loaded at once, never on a page", () => {
    const post = (themeKey: string) => {
      const shown = withImages([]);
      if (shown.kind !== "entry") throw new Error("an entry");
      return draw({ ...shown, entry: { ...shown.entry, type: "post", path: "/news/rye", featuredImage: photo } }, { ...site, themeKey });
    };
    for (const theme of ["studio", "journal"]) {
      const html = post(theme);
      expect(html, theme).toContain('<figure class="forge-featured-image">');
      expect(html, theme).toContain(`srcSet="${url("w800")} 800w, ${url("w1600")} 1600w"`);
      expect(html, theme).toContain('loading="eager"');
    }
    const asPage = withImages([]);
    if (asPage.kind !== "entry") throw new Error("an entry");
    expect(draw({ ...asPage, entry: { ...asPage.entry, featuredImage: photo } })).not.toContain("forge-featured-image");
  });
});
