import { getTableColumns } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sites } from "@/platform/db/schema";
import { FONT_KEYS } from "./_kit/font-choices";
import { FONT_CLASSES, fontClasses } from "./_kit/fonts";
import { kitSettingsSchema } from "./_kit/tokens";
import { activeThemeDefinition, DEFAULT_THEME_KEY, isThemeKey, THEME_KEYS, THEMES, themeDefinition } from "./registry";
import { themeFor, themeManifest, type RenderableSite } from "./render";
import { pageTemplateKey, TEMPLATE_KEYS, type Pagination, type PostCard, type TemplateKey, type TermLink } from "./types";

/** The registry, the manifests and the templates (M4-4, ADR 0012). */

describe("the registry", () => {
  it("holds the plan's two themes, Studio first, each key once", () => {
    expect(THEME_KEYS).toEqual(["studio", "journal"]);
    expect(THEMES.map((theme) => theme.name)).toEqual(["Studio", "Journal"]);
    expect(new Set(THEME_KEYS).size).toBe(THEME_KEYS.length);
  });

  it("the default is Studio, the same as the `sites.theme_key` column's default", () => {
    expect(DEFAULT_THEME_KEY).toBe("studio");
    expect(getTableColumns(sites).themeKey.default).toBe(DEFAULT_THEME_KEY);
  });

  it.each(THEMES.map((theme) => [theme.key, theme] as const))("%s: a complete, valid definition", (_key, theme) => {
    expect(theme.key).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(theme.description.length).toBeGreaterThan(20);
    expect(theme.version).toBeGreaterThanOrEqual(1);
    expect(kitSettingsSchema.safeParse(theme.defaults).success).toBe(true);
    // Its own defaults are variants it draws.
    expect(theme.headerVariants).toContain(theme.defaults.header.variant);
    expect(theme.footerVariants).toContain(theme.defaults.footer.variant);
    expect(theme.options.safeParse({}).success).toBe(true);
    expect(theme.options.safeParse({ anything: 1 }).success).toBe(false); // strict
  });

  it("a key that is not in the list finds nothing, and is drawn with the default: no lookup by name, path or prototype", () => {
    for (const key of ["", "Studio", "STUDIO", " studio", "studio/../journal", "../studio", "__proto__", "constructor", "toString", "hasOwnProperty", "unknown", null, undefined, 42, {}]) {
      expect(themeDefinition(key), String(key)).toBeNull();
      expect(isThemeKey(key), String(key)).toBe(false);
      expect(activeThemeDefinition(key).key, String(key)).toBe("studio");
      expect(themeManifest(key).key, String(key)).toBe("studio");
    }
    expect(themeDefinition("journal")?.name).toBe("Journal");
    expect(themeManifest("journal").key).toBe("journal");
  });
});

describe("the manifests the renderer draws with", () => {
  it.each(THEME_KEYS.map((key) => [key] as const))("%s: its definition, a layout, and every template", (key) => {
    const manifest = themeManifest(key);
    expect(manifest.name).toBe(themeDefinition(key)!.name);
    expect(manifest.defaults).toBe(themeDefinition(key)!.defaults);
    expect(typeof manifest.Layout).toBe("function");
    for (const template of TEMPLATE_KEYS) expect(typeof manifest.templates[template], template).toBe("function");
  });

  it("every curated font is set up, and a page uses only its two", () => {
    expect(Object.keys(FONT_CLASSES).sort()).toEqual([...FONT_KEYS].sort());
    const { context } = themeFor(site("studio"));
    expect(fontClasses(context.settings).split(" ").sort()).toEqual([FONT_CLASSES.inter, FONT_CLASSES.manrope].sort());
  });
});

const site = (themeKey: string, extra: Partial<RenderableSite> = {}): RenderableSite => ({
  name: "Harbor & Pine <Studio>",
  tagline: "Small spaces <script>window.__xss = 1</script>",
  language: "en",
  basePath: "/s/harbor",
  themeKey,
  themeSettings: {},
  ...extra,
});

const cards = (count: number): PostCard[] =>
  Array.from({ length: count }, (_, i) => ({ title: `Post <${i}>`, href: `/s/harbor/blog/post-${i}`, excerpt: i === 0 ? "An excerpt & more" : "", date: { iso: "2026-09-12T08:00:00.000Z", label: "12 September 2026" } }));
const pages = (page: number, total: number): Pagination => ({
  page, pages: total, previousHref: page > 1 ? "/s/harbor/blog" : undefined, nextHref: page < total ? `/s/harbor/blog/page/${page + 1}` : undefined,
});

function render(themeKey: string, template: TemplateKey, extra: Partial<RenderableSite> = {}, list = { posts: cards(2), pagination: pages(1, 2) }) {
  const { theme, context } = themeFor(site(themeKey, extra));
  const { Layout, templates } = theme;
  const body = (() => {
    switch (template) {
      case "page":
      case "page-full-width":
      case "page-landing": {
        const Page = templates[template];
        return <Page context={context} title="About us"><p>Hello</p></Page>;
      }
      case "post": {
        const Post = templates.post;
        const terms: TermLink[] = [{ taxonomy: "category", name: "Bread <3", href: "/s/harbor/blog/category/bread" }, { taxonomy: "tag", name: "Rye", href: "/s/harbor/blog/tag/rye" }];
        return <Post context={context} title="A post" date={{ iso: "2026-09-12T08:00:00.000Z", label: "12 September 2026" }} terms={terms} blogHref="/s/harbor/blog"><p>Hello</p></Post>;
      }
      case "blog-index": {
        const BlogIndex = templates["blog-index"];
        return <BlogIndex context={context} title="Blog" posts={list.posts} pagination={list.pagination} />;
      }
      case "term-archive": {
        const TermArchive = templates["term-archive"];
        return <TermArchive context={context} taxonomy="tag" name="Rye <b>" description="All about rye" blogHref="/s/harbor/blog" posts={list.posts} pagination={list.pagination} />;
      }
      case "coming-soon": {
        const ComingSoon = templates["coming-soon"];
        return <ComingSoon context={context} />;
      }
      case "not-found": {
        const NotFound = templates["not-found"];
        return <NotFound context={context} />;
      }
    }
  })();
  return renderToStaticMarkup(<Layout context={context}>{body}</Layout>);
}

describe("the templates", () => {
  const cases = THEME_KEYS.flatMap((key) => TEMPLATE_KEYS.map((template) => [key, template] as const));

  it.each(cases)("%s / %s: the theme's frame, landmarks, one h1, and the site's own words as text", (key, template) => {
    const html = render(key, template);
    expect(html).toMatch(new RegExp(`^<div data-forge-theme="" data-theme="${key}" class="[^"]+" style="`));
    expect(html.indexOf("forge-skip-link")).toBeLessThan(html.indexOf("<header"));
    expect(html).toContain('href="#content"');
    expect(html).toMatch(/<main id="content"/);
    expect(html.match(/<header/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(html).toMatch(/<footer/);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain("Harbor &amp; Pine &lt;Studio&gt;");
    expect(html).not.toMatch(/<script/i);
    // The style attribute holds the kit's variables and nothing else.
    const style = html.match(/ style="([^"]*)"/)![1]!.replaceAll("&quot;", '"');
    const declarations = style.split(/;(?=--)/);
    expect(declarations.length).toBe(11);
    for (const declaration of declarations) expect(declaration).toMatch(/^--forge-[a-z-]+:[^;{}<>]+;?$/);
  });

  it("links are built from the site's base; an empty menu draws no navigation landmark", () => {
    const html = render("studio", "not-found");
    expect(html).toContain('href="/s/harbor"');
    expect(html).not.toContain("<nav");
    const withMenu = render("studio", "page", { menus: { header: [{ label: "Work", href: "/s/harbor/work" }] } });
    expect(withMenu).toMatch(/<nav aria-label="Main"[^>]*><ul><li><a href="\/s\/harbor\/work">Work<\/a>/);
  });

  it("the header's button: a path gets the site's base, a full address is kept, an unsafe one is never drawn", () => {
    const button = (href: string) => render("studio", "page", { themeSettings: { header: { cta: { label: "Book", href } } } }).match(/<a href="([^"]*)" class="forge-button">Book/)?.[1];
    expect(button("/contact")).toBe("/s/harbor/contact");
    expect(button("https://cal.example.com/x")).toBe("https://cal.example.com/x");
    expect(button("javascript:alert(1)")).toBeUndefined();
    expect(button("//evil.example")).toBeUndefined();
  });

  it("a variant a theme does not draw falls back to its own; colours a site saved are used", () => {
    const html = render("journal", "page", { themeSettings: { header: { variant: "minimal" }, tokens: { colors: { primary: "#123456" } } } });
    expect(html).toContain('class="journal-header"');
    expect(html).toContain("--forge-color-primary:#123456");
  });

  it.each(THEME_KEYS.map((key) => [key] as const))("%s: the site's logo in the header (M6-4), named by the site; its name when there is none", (key) => {
    const logo = { url: "/media/org/o/site/s/2026/10/x/logo.webp", width: 320, height: 120 };
    const html = render(key, "page", { logo });
    expect(html).toContain(`<img src="${logo.url}" alt="Harbor &amp; Pine &lt;Studio&gt;" width="320" height="120" class="forge-logo"`);
    expect(html.match(/forge-logo/g)).toHaveLength(1);
    expect(render(key, "page")).not.toContain("forge-logo");
    expect(render(key, "page", { logo: null })).not.toContain("<img");
  });

  it("a site whose stored theme is unknown is drawn with Studio", () => {
    expect(render("retired-theme", "coming-soon")).toContain('data-theme="studio"');
  });
});

describe("the content templates (M5-6)", () => {
  it.each(THEME_KEYS.map((key) => [key] as const))("%s: a page's three templates; the wide two give the content the wide container", (key) => {
    expect(render(key, "page")).not.toContain("forge-prose--wide");
    for (const template of ["page-full-width", "page-landing"] as const) {
      const html = render(key, template);
      expect(html, template).toContain("forge-container--wide");
      expect(html, template).toContain('<div class="forge-prose forge-prose--wide"><p>Hello</p></div>');
    }
  });

  it("a page's stored template picks the template; anything else is the default", () => {
    expect([null, undefined, "default", "full-width", "landing", "Landing", "__proto__", "hasOwnProperty", "page-landing", ""].map(pageTemplateKey)).toEqual([
      "page", "page", "page", "page-full-width", "page-landing", "page", "page", "page", "page", "page",
    ]);
  });

  it.each(THEME_KEYS.map((key) => [key] as const))("%s: a post has its date, its categories and tags as links, and a way back to the blog", (key) => {
    const html = render(key, "post");
    expect(html).toContain('<time dateTime="2026-09-12T08:00:00.000Z">12 September 2026</time>');
    expect(html).toContain('<a href="/s/harbor/blog/category/bread">Bread &lt;3</a>');
    expect(html).toContain('<a href="/s/harbor/blog/tag/rye">Rye</a>');
    // The way back to the blog: Studio's eyebrow; Journal's "All posts" (its kicker names the post's categories).
    expect(html).toMatch(/<a href="\/s\/harbor\/blog">(Blog|<span aria-hidden="true">← <\/span>All posts)<\/a>/);
    expect(html).toMatch(/<h1[^>]*>A post<\/h1>/);
  });

  it.each(THEME_KEYS.map((key) => [key] as const))("%s: a list of posts: each title an h2 link, its date and excerpt as text; pages linked both ways", (key) => {
    const html = render(key, "blog-index", {}, { posts: cards(2), pagination: pages(2, 3) });
    expect(html).toMatch(/<h2 class="(forge-post-card__title|journal-entry__title)"><a href="\/s\/harbor\/blog\/post-0">Post &lt;0&gt;<\/a><\/h2>/);
    expect(html).toContain("An excerpt &amp; more");
    expect(html.match(/<h2[ >]/g)).toHaveLength(2);
    expect(html).toContain('<nav class="forge-pagination" aria-label="Pages of posts">');
    expect(html).toContain('href="/s/harbor/blog" rel="prev"');
    expect(html).toContain('href="/s/harbor/blog/page/3" rel="next"');
    expect(html).toContain("Page 2 of 3");
  });

  it.each(THEME_KEYS.map((key) => [key] as const))("%s: an empty list says so; one page has no page links", (key) => {
    const empty = render(key, "blog-index", {}, { posts: [], pagination: pages(1, 1) });
    expect(empty).toContain(key === "journal" ? "Nothing has been published here yet." : "No posts yet.");
    expect(empty).not.toContain("forge-pagination");
    expect(render(key, "term-archive", {}, { posts: [], pagination: pages(1, 1) })).toContain(key === "journal" ? "Nothing is filed under Rye &lt;b&gt; yet." : "No posts here yet.");
  });

  it.each(THEME_KEYS.map((key) => [key] as const))("%s: a term's archive names it, and what it is, as text", (key) => {
    const html = render(key, "term-archive");
    expect(html).toMatch(/<h1[^>]*>Rye &lt;b&gt;<\/h1>/);
    expect(html).toContain("Tag");
    expect(html).toContain("All about rye");
    expect(html).not.toContain("<b>");
  });
});

describe("Studio's header and footer variants (M8-1)", () => {
  const settings = (header: Record<string, unknown>, footer: Record<string, unknown> = {}) => ({
    header: { variant: "classic", sticky: false, cta: { label: "Book <now>", href: "/contact" }, ...header },
    footer: { variant: "simple", copyright: "All rights <reserved>", showSocial: true, ...footer },
  });
  const social = [{ label: "Instagram", href: "https://instagram.com/harbor" }];
  const html = (themeKey: string, themeSettings: unknown) => render(themeKey, "page", { themeSettings, social });

  it("draws all three headers: the call to action as a button (classic, centered) or a plain link (minimal); the centered one with the tagline", () => {
    const classic = html("studio", settings({ variant: "classic" }));
    expect(classic).toContain('data-variant="classic"');
    expect(classic).toMatch(/<a href="\/s\/harbor\/contact" class="forge-button">Book &lt;now&gt;<\/a>/);
    expect(classic).not.toContain("studio-header__tagline");
    const centered = html("studio", settings({ variant: "centered", sticky: true }));
    expect(centered).toContain('data-variant="centered"');
    expect(centered).toContain("data-sticky");
    expect(centered).toContain('<p class="studio-header__tagline">Small spaces &lt;script&gt;window.__xss = 1&lt;/script&gt;</p>');
    const minimal = html("studio", settings({ variant: "minimal" }));
    expect(minimal).toContain('data-variant="minimal"');
    expect(minimal).toMatch(/<a href="\/s\/harbor\/contact" class="studio-header__link">Book &lt;now&gt;<\/a>/);
    expect(html("studio", settings({ cta: null }))).not.toContain("forge-button");
  });

  it("draws both footers, with the copyright line, and the social links only when the toggle is on", () => {
    const simple = html("studio", settings({}, { variant: "simple" }));
    expect(simple).toContain('data-variant="simple"');
    expect(simple).toContain("All rights &lt;reserved&gt;");
    expect(simple).toContain('href="https://instagram.com/harbor"');
    const columns = html("studio", settings({}, { variant: "columns" }));
    expect(columns).toContain('data-variant="columns"');
    expect(columns.match(/class="studio-footer__column"/g)).toHaveLength(3);
    expect(columns).toContain("All rights &lt;reserved&gt;");
    expect(html("studio", settings({}, { variant: "columns", showSocial: false }))).not.toContain("instagram.com");
  });

  it("a variant the theme does not draw is drawn as its first (Journal: centered and simple), and the stored value is kept for switching back", () => {
    const journal = html("journal", settings({ variant: "minimal" }, { variant: "columns" }));
    expect(journal).toContain("journal-header");
    expect(journal).not.toContain('data-variant="minimal"');
    expect(journal).not.toContain("studio-footer__column");
    const { context } = themeFor(site("journal", { themeSettings: settings({ variant: "minimal" }, { variant: "columns" }) }));
    expect(context.settings.header.variant).toBe("centered");
    expect(context.settings.footer.variant).toBe("simple");
    expect(themeFor(site("studio", { themeSettings: settings({ variant: "minimal" }, { variant: "columns" }) })).context.settings.header.variant).toBe("minimal");
  });
});

describe("Journal's own templates (M8-2)", () => {
  const { context, theme } = themeFor(site("journal"));
  const { JournalPost, JournalBlogIndex, JournalTermArchive, JournalPageFullWidth, JournalPageLanding } = {
    JournalPost: theme.templates.post, JournalBlogIndex: theme.templates["blog-index"], JournalTermArchive: theme.templates["term-archive"],
    JournalPageFullWidth: theme.templates["page-full-width"], JournalPageLanding: theme.templates["page-landing"],
  };
  const image = { alt: "A rye loaf", width: 1600, height: 900, sources: [{ url: "/media/o/s/m/v1/w800/loaf.webp", width: 800, height: 450 }, { url: "/media/o/s/m/v1/w1600/loaf.webp", width: 1600, height: 900 }] };
  const terms: TermLink[] = [
    { taxonomy: "category", name: "Bread", href: "/s/harbor/blog/category/bread" },
    { taxonomy: "category", name: "Seasons", href: "/s/harbor/blog/category/seasons" },
    { taxonomy: "tag", name: "Rye", href: "/s/harbor/blog/tag/rye" },
  ];
  const html = (element: React.ReactElement) => renderToStaticMarkup(element);

  it("draws every template with its own design: no kit template is left", () => {
    for (const [template, component] of Object.entries(theme.templates)) expect(component.name, template).toMatch(/^Journal/);
  });

  it("a post: its categories as the kicker, the date, the image across the wide column with its widths and size, what it is filed under, the way back", () => {
    const post = html(<JournalPost context={context} title="Rye season" date={{ iso: "2026-09-12T08:00:00.000Z", label: "12 September 2026" }} terms={terms} blogHref="/s/harbor/blog" featuredImage={image}><p>Words</p></JournalPost>);
    expect(post).toMatch(/<p class="journal-kicker"><a href="\/s\/harbor\/blog\/category\/bread">Bread<\/a><span aria-hidden="true"> · <\/span><a href="\/s\/harbor\/blog\/category\/seasons">Seasons<\/a><\/p>/);
    expect(post).toContain('<h1 class="journal-post__title">Rye season</h1>');
    expect(post).toContain('<time dateTime="2026-09-12T08:00:00.000Z">12 September 2026</time>');
    expect(post).toContain('class="forge-container forge-container--wide journal-post__image"');
    expect(post).toMatch(/<img src="\/media\/o\/s\/m\/v1\/w800\/loaf\.webp" srcSet="\/media\/o\/s\/m\/v1\/w800\/loaf\.webp 800w, \/media\/o\/s\/m\/v1\/w1600\/loaf\.webp 1600w" sizes="[^"]+" width="1600" height="900" alt="A rye loaf" loading="eager"/);
    expect(post).toContain('<p class="journal-terms__label" id="terms-categories">Filed under</p>');
    expect(post).toContain('<ul aria-labelledby="terms-tags"><li><a href="/s/harbor/blog/tag/rye">Rye</a></li></ul>');
    expect(post).toContain('<a href="/s/harbor/blog"><span aria-hidden="true">← </span>All posts</a>');
  });

  it("a post without what is optional leaves nothing behind: no image, no date, no terms (the kicker is the blog), no title", () => {
    const bare = html(<JournalPost context={context} title="" date={null} terms={[]} blogHref="/s/harbor/blog" featuredImage={null}><p>Words</p></JournalPost>);
    expect(bare).toContain('<p class="journal-kicker"><a href="/s/harbor/blog">Blog</a></p>');
    expect(bare).toContain('<h1 class="journal-post__title">Untitled</h1>');
    for (const absent of ["<img", "<time", "journal-terms", "journal-post__image", "journal-post__date"]) expect(bare, absent).not.toContain(absent);
  });

  it("the blog: the first page's newest post is the lead; later pages have none; the page is named; entries are an ordered list of h2 links", () => {
    const first = html(<JournalBlogIndex context={context} title="Blog" posts={cards(3)} pagination={pages(1, 2)} />);
    expect(first.match(/journal-entry--lead/g)).toHaveLength(1);
    expect(first).toContain('<ol class="journal-entries">');
    expect(first.match(/<h2 class="journal-entry__title">/g)).toHaveLength(3);
    expect(first).toContain('<p class="journal-archive__where">Page 1 of 2</p>');
    const second = html(<JournalBlogIndex context={context} title="Blog" posts={cards(2)} pagination={pages(2, 2)} />);
    expect(second).not.toContain("journal-entry--lead");
    expect(html(<JournalBlogIndex context={context} title="Blog" posts={cards(1)} pagination={pages(1, 1)} />)).not.toContain("journal-archive__where");
  });

  it("an archive says what it is (category or tag), with its description, and never sets a lead", () => {
    const archive = html(<JournalTermArchive context={context} taxonomy="category" name="Bread" description="All about bread" blogHref="/s/harbor/blog" posts={cards(2)} pagination={pages(1, 1)} />);
    expect(archive).toContain('<p class="journal-kicker"><a href="/s/harbor/blog">Blog</a><span aria-hidden="true"> · </span>Category</p>');
    expect(archive).toContain('<p class="journal-archive__description">All about bread</p>');
    expect(archive).not.toContain("journal-entry--lead");
  });

  it("the full-width page and the landing page: the content across the wide column; the landing's title in its opening", () => {
    const full = html(<JournalPageFullWidth context={context} title="Work"><p>x</p></JournalPageFullWidth>);
    expect(full).toContain('class="journal-page journal-page--full"');
    expect(full).toContain('<div class="forge-container forge-container--wide"><div class="forge-prose forge-prose--wide">');
    const landing = html(<JournalPageLanding context={context} title="Welcome"><p>x</p></JournalPageLanding>);
    expect(landing).toContain('<header class="journal-landing__opening"><div class="forge-container"><h1 class="journal-landing__title">Welcome</h1>');
  });
});

describe("menus: two levels, new tabs, both themes (M8-3)", () => {
  const menus = {
    header: [
      { label: "Work", href: "/s/harbor/work" },
      { label: "Services", href: "/s/harbor/services", children: [{ label: "Interiors", href: "/s/harbor/services/interiors" }, { label: "Kitchens", href: "/s/harbor/services/kitchens" }] },
      { label: "Shop", href: "https://shop.example.com", newTab: true },
    ],
    footer: [{ label: "Studio", href: "/s/harbor/about", children: [{ label: "Team", href: "/s/harbor/about/team" }] }, { label: "Privacy", href: "/s/harbor/privacy" }],
  };

  for (const themeKey of THEME_KEYS) {
    it(`${themeKey}: the header's links under a link open from a button beside it, named for it; nothing runs`, () => {
      const html = render(themeKey, "page", { menus });
      const main = html.match(/<nav aria-label="Main"[^]*?<\/nav>/)?.[0] ?? "";
      expect(main).toContain('class="forge-nav forge-nav--disclosure"');
      expect(main).toMatch(
        /<li class="forge-nav__parent"><a href="\/s\/harbor\/services">Services<\/a><details class="forge-nav__more"><summary class="forge-nav__toggle"><span class="forge-visually-hidden">More links under Services<\/span><svg[^>]*aria-hidden="true"/,
      );
      // The list follows the <details>: the page's styles show it while it is open.
      expect(main).toMatch(/<\/summary><\/details><ul class="forge-nav__sub"><li><a href="\/s\/harbor\/services\/interiors">Interiors<\/a><\/li><li><a href="\/s\/harbor\/services\/kitchens">Kitchens<\/a><\/li><\/ul><\/li>/);
      expect(main).not.toMatch(/<script|onclick|onload/i);
    });

    it(`${themeKey}: the footer lists the links under a link; a new tab says so and gives no access back`, () => {
      const html = render(themeKey, "page", { menus });
      const footer = html.match(/<nav aria-label="Footer"[^]*?<\/nav>/)?.[0] ?? "";
      expect(footer).toContain('class="forge-nav forge-nav--list"');
      expect(footer).toMatch(/<a href="\/s\/harbor\/about">Studio<\/a><ul class="forge-nav__sub"><li><a href="\/s\/harbor\/about\/team">Team<\/a>/);
      expect(footer).not.toContain("<details");
      expect(html).toContain('<a href="https://shop.example.com" rel="noopener noreferrer" target="_blank">Shop<span class="forge-visually-hidden"> (opens in a new tab)</span></a>');
    });
  }

  it("the social links keep their own rel; a menu link opening a new tab adds noopener once", () => {
    const html = render("studio", "page", { social: [{ label: "Instagram", href: "https://instagram.com/x", newTab: true }] });
    expect(html).toContain('<a href="https://instagram.com/x" rel="me noopener noreferrer" target="_blank">Instagram');
  });
});
