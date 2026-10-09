import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FONT_CHOICES, FONT_KEYS, fontStack } from "./font-choices";
import { hexColor, kitSettingsSchema, parseThemeSettings, readableOn, readThemeOptions, readThemeSettings, safeHref, themeVariables, type KitSettings } from "./tokens";

/** The theme kit's settings (M4-4, plan §7): what a site may set, and the only CSS it can produce. */

const defaults: KitSettings = {
  tokens: { colors: { primary: "#1d4ed8", accent: "#0f766e", background: "#ffffff", text: "#0f172a" }, fonts: { heading: "manrope", body: "inter" } },
  header: { variant: "classic", sticky: false, cta: null },
  footer: { variant: "simple", copyright: "", showSocial: true },
  layout: { width: "normal", radius: "medium", density: "normal" },
};
const theme = { key: "studio", options: z.strictObject({ heroStyle: z.enum(["plain", "tinted"]).default("plain") }) };

describe("a colour", () => {
  it("is #rgb or #rrggbb, stored as lowercase #rrggbb", () => {
    expect(hexColor.parse("#1D4ED8")).toBe("#1d4ed8");
    expect(hexColor.parse(" #abc ")).toBe("#aabbcc");
    expect(hexColor.parse("#fff\n")).toBe("#ffffff"); // surrounding whitespace is trimmed, never kept
  });

  it("is nothing else: no names, functions, variables, alpha, or anything that could end a declaration", () => {
    for (const unsafe of ["red", "#12345g", "#1234", "#1234567", "1d4ed8", "#fff;}", "#fff; background:url(x)", "url(https://evil.example)", "var(--x)",
      "rgb(0,0,0)", "expression(alert(1))", "#fff\n;", "#fff</style>", "", "#"]) {
      expect(hexColor.safeParse(unsafe).success, JSON.stringify(unsafe)).toBe(false);
    }
  });
});

describe("a link a theme may draw (the header's button)", () => {
  it("is a path on the site, or a web, mail or phone address", () => {
    for (const ok of ["/contact", "/", "/a/b?c=d#e", "https://example.com/x", "http://example.com", "mailto:hello@example.com", "tel:+15551234567"]) {
      expect(safeHref.safeParse(ok).success, ok).toBe(true);
    }
  });

  it("is never a script, a data URL, another origin written as a path, or something with spaces or quotes", () => {
    for (const unsafe of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", " javascript:alert(1)", "data:text/html,<script>", "vbscript:x", "//evil.example",
      "/\\evil.example", "\\\\evil", "https://evil.example/\"><script>", "https://a b", "ftp://example.com", "file:///etc/passwd", "contact", "", "x".repeat(501)]) {
      expect(safeHref.safeParse(unsafe).success, JSON.stringify(unsafe)).toBe(false);
    }
  });
});

describe("submitted settings (the strict path, for the appearance editor)", () => {
  it("accept a complete, valid set, normalised, and keep other themes' stored options", () => {
    const stored = { options: { journal: { dropCaps: true } } };
    const parsed = parseThemeSettings({ ...defaults, tokens: { ...defaults.tokens, colors: { ...defaults.tokens.colors, primary: "#ABC" } }, options: { studio: { heroStyle: "tinted" } } }, theme, stored);
    expect(parsed.tokens.colors.primary).toBe("#aabbcc");
    expect(parsed.options).toEqual({ journal: { dropCaps: true }, studio: { heroStyle: "tinted" } });
  });

  it("refuse an unknown key anywhere, a missing group, an unsafe value, or options for another theme", () => {
    const attempts: unknown[] = [
      { ...defaults, extra: 1 },
      { ...defaults, tokens: { ...defaults.tokens, css: "body{display:none}" } },
      { ...defaults, header: { ...defaults.header, cta: { label: "Go", href: "javascript:alert(1)" } } },
      { ...defaults, tokens: { ...defaults.tokens, fonts: { heading: "comic-sans", body: "inter" } } },
      { ...defaults, layout: { ...defaults.layout, width: "100vw" } },
      { tokens: defaults.tokens, header: defaults.header, footer: defaults.footer },
      { ...defaults, options: { journal: {} } },
      { ...defaults, options: { studio: { heroStyle: "<script>" } } },
      { ...defaults, options: { studio: { unknown: true } } },
      null,
      "settings",
    ];
    for (const attempt of attempts) expect(() => parseThemeSettings(attempt, theme), JSON.stringify(attempt)).toThrow(z.ZodError);
  });

  it("the kit's schema is strict at every level", () => {
    expect(kitSettingsSchema.safeParse(defaults).success).toBe(true);
    expect(kitSettingsSchema.safeParse({ ...defaults, footer: { ...defaults.footer, html: "<b>" } }).success).toBe(false);
  });
});

describe("stored settings (the lenient path, for drawing a page)", () => {
  it("nothing stored: the theme's defaults", () => {
    expect(readThemeSettings({}, defaults)).toEqual(defaults);
    expect(readThemeSettings(null, defaults)).toEqual(defaults);
    expect(readThemeSettings("garbage", defaults)).toEqual(defaults);
  });

  it("each stored value that passes its rule is used; each that does not falls back alone, without taking the others with it", () => {
    const stored = {
      tokens: { colors: { primary: "#ff0000", accent: "url(x)", text: 42 }, fonts: { heading: "lora", body: "../../etc/passwd" } },
      header: { sticky: true, cta: { label: "Call", href: "javascript:alert(1)" } },
      layout: { width: "wide", density: "<script>" },
      footer: "not an object",
    };
    const read = readThemeSettings(stored, defaults);
    expect(read.tokens.colors).toEqual({ primary: "#ff0000", accent: defaults.tokens.colors.accent, background: "#ffffff", text: defaults.tokens.colors.text });
    expect(read.tokens.fonts).toEqual({ heading: "lora", body: "inter" });
    expect(read.header).toEqual({ variant: "classic", sticky: true, cta: null }); // an unsafe button is no button
    expect(read.layout).toEqual({ width: "wide", radius: "medium", density: "normal" });
    expect(read.footer).toEqual(defaults.footer);
  });

  it("a theme's own options: its schema, or its defaults", () => {
    expect(readThemeOptions({ options: { studio: { heroStyle: "tinted" } } }, theme)).toEqual({ heroStyle: "tinted" });
    expect(readThemeOptions({ options: { studio: { heroStyle: "loud" } } }, theme)).toEqual({ heroStyle: "plain" });
    expect(readThemeOptions({}, theme)).toEqual({ heroStyle: "plain" });
  });
});

describe("the CSS a site's settings produce", () => {
  it("is custom properties named by the kit, and nothing else", () => {
    const vars = themeVariables(readThemeSettings({ tokens: { colors: { primary: "#fff;} body{display:none}" } } }, defaults));
    for (const [name, value] of Object.entries(vars)) {
      expect(name).toMatch(/^--forge-[a-z-]+$/);
      expect(value, name).not.toMatch(/[;{}<>\\]|url\(|expression|@import|\/\*/i);
    }
    expect(vars["--forge-color-primary"]).toBe("#1d4ed8");
  });

  it("every value is a validated colour, a curated font stack, or a value from a closed table", () => {
    for (const width of ["narrow", "normal", "wide"] as const) {
      for (const radius of ["none", "small", "medium", "large"] as const) {
        const vars = themeVariables({ ...defaults, layout: { width, radius, density: "relaxed" } });
        expect(vars["--forge-content-width"]).toMatch(/^\d+rem$/);
        expect(vars["--forge-radius"]).toMatch(/^(0|[\d.]+rem)$/);
        expect(vars["--forge-space"]).toMatch(/^[\d.]+$/);
      }
    }
    for (const key of FONT_KEYS) {
      const vars = themeVariables({ ...defaults, tokens: { ...defaults.tokens, fonts: { heading: key, body: key } } });
      expect(vars["--forge-font-heading"]).toBe(fontStack(key));
      expect(vars["--forge-font-heading"]).toMatch(new RegExp(`^var\\(--font-forge-${key}\\), (ui-sans-serif|ui-serif), `));
    }
  });

  it("text on the primary and accent colours is white or near-black, whichever reads better", () => {
    expect(readableOn("#1d4ed8")).toBe("#ffffff");
    expect(readableOn("#fde047")).toBe("#111111");
    expect(readableOn("#ffffff")).toBe("#111111");
    expect(readableOn("#000000")).toBe("#ffffff");
  });

  it("the curated fonts: ten, each a sans or a serif, with unique keys", () => {
    expect(FONT_CHOICES).toHaveLength(10);
    expect(new Set(FONT_KEYS).size).toBe(10);
    for (const font of FONT_CHOICES) expect(["sans", "serif"]).toContain(font.kind);
  });
});
