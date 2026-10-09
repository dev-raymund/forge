import { z } from "zod";
import { FONT_KEYS, fontStack, type FontKey } from "./font-choices";

/**
 * A site's theme settings (plan §7): what the customer can change, the rules
 * each value must meet, and the CSS variables built from them. Pure and
 * client-safe.
 *
 * Stored in `site_settings.theme`:
 *
 *   { tokens: { colors, fonts }, header, footer, layout,   kit-level: every theme reads them,
 *     options: { [themeKey]: { … } } }                       so switching keeps the branding;
 *                                                            each theme's own extras
 *
 * Every value is a closed choice or has a strict shape: a colour is `#rrggbb`,
 * a font is a key from the curated list, a width is one of three words. No
 * value is ever copied into CSS as text the customer wrote. The CSS that
 * reaches a page is a set of custom properties built by `themeVariables` from
 * values that passed these schemas.
 */

/** `#rgb` or `#rrggbb`, stored as lowercase `#rrggbb`. Nothing else is a colour here: no names, no functions, no `;`. */
export const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use a colour like #1d4ed8.")
  .transform((value) => {
    const hex = value.slice(1).toLowerCase();
    return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
  });

const fontKey = z.enum(FONT_KEYS, "Choose a font from the list.");

/** A link a theme may render (the header's button): a path on the site, or a web, mail or phone address. */
export const safeHref = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    if (/^\/(?!\/)/.test(value)) return !/[\\\s]/.test(value);
    try {
      const url = new URL(value);
      return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) && !/[\s<>"]/.test(value);
    } catch {
      return false;
    }
  }, "Use a path on the site, like /contact, or a full address starting with https://.");

export const HEADER_VARIANTS = ["classic", "centered", "minimal"] as const;
export const FOOTER_VARIANTS = ["simple", "columns"] as const;
export const CONTENT_WIDTHS = ["narrow", "normal", "wide"] as const;
export const CORNER_RADII = ["none", "small", "medium", "large"] as const;
export const DENSITIES = ["compact", "normal", "relaxed"] as const;

export type HeaderVariant = (typeof HEADER_VARIANTS)[number];
export type FooterVariant = (typeof FOOTER_VARIANTS)[number];

const colors = z.strictObject({ primary: hexColor, accent: hexColor, background: hexColor, text: hexColor });
const fonts = z.strictObject({ heading: fontKey, body: fontKey });
const header = z.strictObject({
  variant: z.enum(HEADER_VARIANTS),
  sticky: z.boolean(),
  cta: z.strictObject({ label: z.string().trim().min(1).max(40), href: safeHref }).nullable(),
});
const footer = z.strictObject({
  variant: z.enum(FOOTER_VARIANTS),
  copyright: z.string().trim().max(200),
  showSocial: z.boolean(),
});
const layout = z.strictObject({ width: z.enum(CONTENT_WIDTHS), radius: z.enum(CORNER_RADII), density: z.enum(DENSITIES) });

/** The kit-level settings, complete. Every theme has a full set of defaults of this shape. */
export const kitSettingsSchema = z.strictObject({ tokens: z.strictObject({ colors, fonts }), header, footer, layout });
export type KitSettings = z.output<typeof kitSettingsSchema>;

/** What `site_settings.theme` holds: the kit-level settings, and each theme's own options by its key. */
export type ThemeSettings = KitSettings & { options: Record<string, Record<string, unknown>> };

/**
 * Validates settings someone submitted (the appearance editor, M8-1), for one
 * theme. Strict: an unknown key, an unsafe value or a missing group is a
 * `ZodError`, and nothing about the stored settings changes. The options of
 * other themes are left as they are (switching back restores them).
 */
export function parseThemeSettings(
  input: unknown,
  theme: { key: string; options: z.ZodType<Record<string, unknown>> },
  stored: unknown = {},
): ThemeSettings {
  const { options = {}, ...kit } = (typeof input === "object" && input !== null ? input : {}) as { options?: unknown };
  const settings = kitSettingsSchema.parse(kit);
  // Only the edited theme's options may be submitted; any other key is refused.
  const submitted = z.strictObject({ [theme.key]: z.unknown().optional() }).parse(options) as Record<string, unknown>;
  const kept = storedOptions(stored);
  return { ...settings, options: { ...kept, [theme.key]: theme.options.parse(submitted[theme.key] ?? {}) } };
}

function storedOptions(stored: unknown): Record<string, Record<string, unknown>> {
  const options = (stored as { options?: unknown } | null)?.options;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return {};
  return Object.fromEntries(Object.entries(options).filter(([, value]) => typeof value === "object" && value !== null && !Array.isArray(value))) as Record<
    string,
    Record<string, unknown>
  >;
}

/** One stored value, if it passes its own rule; otherwise the default. */
function pick<T>(schema: z.ZodType<T>, stored: unknown, fallback: T): T {
  const parsed = schema.safeParse(stored);
  return parsed.success ? parsed.data : fallback;
}

const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((node, key) => (typeof node === "object" && node !== null && !Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined), value);

/**
 * The settings a page renders with: what is stored, value by value, wherever
 * it passes its rule, and the theme's default everywhere else. Never throws: a
 * damaged or half-written row cannot take a site down, and one bad value
 * cannot take the others with it.
 */
export function readThemeSettings(stored: unknown, defaults: KitSettings): KitSettings {
  const d = defaults;
  const field = <T>(schema: z.ZodType<T>, fallback: T, ...path: string[]) => pick(schema, at(stored, ...path), fallback);
  const cta = at(stored, "header", "cta");
  return {
    tokens: {
      colors: {
        primary: field(hexColor, d.tokens.colors.primary, "tokens", "colors", "primary"),
        accent: field(hexColor, d.tokens.colors.accent, "tokens", "colors", "accent"),
        background: field(hexColor, d.tokens.colors.background, "tokens", "colors", "background"),
        text: field(hexColor, d.tokens.colors.text, "tokens", "colors", "text"),
      },
      fonts: {
        heading: field(fontKey, d.tokens.fonts.heading, "tokens", "fonts", "heading"),
        body: field(fontKey, d.tokens.fonts.body, "tokens", "fonts", "body"),
      },
    },
    header: {
      variant: field(z.enum(HEADER_VARIANTS), d.header.variant, "header", "variant"),
      sticky: field(z.boolean(), d.header.sticky, "header", "sticky"),
      cta: cta === undefined ? d.header.cta : pick(header.shape.cta, cta, d.header.cta),
    },
    footer: {
      variant: field(z.enum(FOOTER_VARIANTS), d.footer.variant, "footer", "variant"),
      copyright: field(z.string().trim().max(200), d.footer.copyright, "footer", "copyright"),
      showSocial: field(z.boolean(), d.footer.showSocial, "footer", "showSocial"),
    },
    layout: {
      width: field(z.enum(CONTENT_WIDTHS), d.layout.width, "layout", "width"),
      radius: field(z.enum(CORNER_RADII), d.layout.radius, "layout", "radius"),
      density: field(z.enum(DENSITIES), d.layout.density, "layout", "density"),
    },
  };
}

/** A theme's own stored options, if they pass its schema; otherwise its defaults. */
export function readThemeOptions<T extends Record<string, unknown>>(stored: unknown, theme: { key: string; options: z.ZodType<T> }): T {
  const parsed = theme.options.safeParse(at(stored, "options", theme.key) ?? {});
  return parsed.success ? parsed.data : theme.options.parse({});
}

// ── CSS variables ────────────────────────────────────────────────────────────

const WIDTHS: Record<(typeof CONTENT_WIDTHS)[number], string> = { narrow: "40rem", normal: "48rem", wide: "72rem" };
const RADII: Record<(typeof CORNER_RADII)[number], string> = { none: "0", small: "0.25rem", medium: "0.5rem", large: "1rem" };
const SPACING: Record<(typeof DENSITIES)[number], string> = { compact: "0.85", normal: "1", relaxed: "1.2" };

/** Relative luminance (WCAG 2) of a validated `#rrggbb`. */
export function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Text on a coloured surface: white or near-black, whichever reads better (WCAG contrast). */
export function readableOn(hex: string): "#ffffff" | "#111111" {
  const l = luminance(hex);
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / (luminance("#111111") + 0.05)) ? "#ffffff" : "#111111";
}

export type ThemeVariables = Record<`--forge-${string}`, string>;

/**
 * The CSS custom properties of a site, from its validated settings. The only
 * CSS a site's settings ever produce: names are fixed here, and every value is
 * a validated colour, a font stack from the curated list, or a value from the
 * tables above. Applied as the theme root's `style`, so there is no stylesheet
 * text for anything to break out of.
 */
export function themeVariables(settings: KitSettings): ThemeVariables {
  const { colors, fonts } = settings.tokens;
  const font = (key: FontKey) => fontStack(key);
  return {
    "--forge-color-primary": colors.primary,
    "--forge-color-on-primary": readableOn(colors.primary),
    "--forge-color-accent": colors.accent,
    "--forge-color-on-accent": readableOn(colors.accent),
    "--forge-color-background": colors.background,
    "--forge-color-text": colors.text,
    "--forge-font-heading": font(fonts.heading),
    "--forge-font-body": font(fonts.body),
    "--forge-content-width": WIDTHS[settings.layout.width],
    "--forge-radius": RADII[settings.layout.radius],
    "--forge-space": SPACING[settings.layout.density],
  };
}
