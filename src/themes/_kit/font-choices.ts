/**
 * The curated fonts a site can choose from (plan §7). Pure and client-safe:
 * keys, names and fallbacks only. The font files themselves are set up in
 * ./fonts.ts, with `next/font`, on the rendering side.
 *
 * A key is what `site_settings.theme` stores. Adding a font is a line here
 * and one in ./fonts.ts; a test fails when the two lists differ.
 */

const SANS_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SERIF_FALLBACK = 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif';

export const FONT_CHOICES = [
  { key: "inter", label: "Inter", kind: "sans" },
  { key: "dm-sans", label: "DM Sans", kind: "sans" },
  { key: "manrope", label: "Manrope", kind: "sans" },
  { key: "source-sans-3", label: "Source Sans 3", kind: "sans" },
  { key: "work-sans", label: "Work Sans", kind: "sans" },
  { key: "fraunces", label: "Fraunces", kind: "serif" },
  { key: "literata", label: "Literata", kind: "serif" },
  { key: "lora", label: "Lora", kind: "serif" },
  { key: "playfair-display", label: "Playfair Display", kind: "serif" },
  { key: "source-serif-4", label: "Source Serif 4", kind: "serif" },
] as const;

export type FontKey = (typeof FONT_CHOICES)[number]["key"];
export const FONT_KEYS = FONT_CHOICES.map((font) => font.key) as [FontKey, ...FontKey[]];

/** The CSS custom property `next/font` defines for a font: `--font-forge-{key}`. */
export const fontVariable = (key: FontKey): `--font-forge-${FontKey}` => `--font-forge-${key}`;

/** The value of a theme's font variable: the loaded font first, then the system's fonts of the same kind. */
export function fontStack(key: FontKey): string {
  const font = FONT_CHOICES.find((choice) => choice.key === key)!;
  return `var(${fontVariable(key)}), ${font.kind === "serif" ? SERIF_FALLBACK : SANS_FALLBACK}`;
}
