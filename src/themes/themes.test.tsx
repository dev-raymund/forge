import { getTableColumns } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sites } from "@/platform/db/schema";
import { FONT_KEYS } from "./_kit/font-choices";
import { FONT_CLASSES, fontClasses } from "./_kit/fonts";
import { kitSettingsSchema } from "./_kit/tokens";
import { activeThemeDefinition, DEFAULT_THEME_KEY, isThemeKey, THEME_KEYS, THEMES, themeDefinition } from "./registry";
import { themeFor, themeManifest, type RenderableSite } from "./render";
import { TEMPLATE_KEYS, type TemplateKey } from "./types";

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

function render(themeKey: string, template: TemplateKey, extra: Partial<RenderableSite> = {}) {
  const { theme, context } = themeFor(site(themeKey, extra));
  const { Layout, templates } = theme;
  const Page = templates.page;
  const ComingSoon = templates["coming-soon"];
  const NotFound = templates["not-found"];
  const body = template === "page" ? <Page context={context} title="About us"><p>Hello</p></Page> : template === "coming-soon" ? <ComingSoon context={context} /> : <NotFound context={context} />;
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

  it("a site whose stored theme is unknown is drawn with Studio", () => {
    expect(render("retired-theme", "coming-soon")).toContain('data-theme="studio"');
  });
});
