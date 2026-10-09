import { DM_Sans, Fraunces, Inter, Literata, Lora, Manrope, Playfair_Display, Source_Sans_3, Source_Serif_4, Work_Sans } from "next/font/google";
import type { FontKey } from "./font-choices";
import type { KitSettings } from "./tokens";

/**
 * The curated fonts (./font-choices.ts), self-hosted by `next/font`: the files
 * are fetched once, at build time, and served from the app. A visitor's browser
 * never asks Google for anything (plan §7).
 *
 * Every font is declared, none is preloaded: a page puts only its site's
 * heading and body fonts in use (`fontClasses`), and a browser downloads a
 * font only when something on the page uses it. Latin and Latin Extended;
 * other scripts fall back to the system's fonts.
 *
 * `next/font` needs each call written out with literal options.
 */
const inter = Inter({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, variable: "--font-forge-inter" });
const dmSans = DM_Sans({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, variable: "--font-forge-dm-sans" });
const manrope = Manrope({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, variable: "--font-forge-manrope" });
const sourceSans3 = Source_Sans_3({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, variable: "--font-forge-source-sans-3" });
const workSans = Work_Sans({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, variable: "--font-forge-work-sans" });
const fraunces = Fraunces({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, variable: "--font-forge-fraunces" });
const literata = Literata({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, variable: "--font-forge-literata" });
const lora = Lora({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, variable: "--font-forge-lora" });
const playfairDisplay = Playfair_Display({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, variable: "--font-forge-playfair-display" });
const sourceSerif4 = Source_Serif_4({ subsets: ["latin", "latin-ext"], display: "swap", preload: false, variable: "--font-forge-source-serif-4" });

/** The class that defines each font's `--font-forge-{key}` variable. */
export const FONT_CLASSES: Readonly<Record<FontKey, string>> = {
  inter: inter.variable,
  "dm-sans": dmSans.variable,
  manrope: manrope.variable,
  "source-sans-3": sourceSans3.variable,
  "work-sans": workSans.variable,
  fraunces: fraunces.variable,
  literata: literata.variable,
  lora: lora.variable,
  "playfair-display": playfairDisplay.variable,
  "source-serif-4": sourceSerif4.variable,
};

/** The classes a site's page needs: its heading and body fonts, and no others. */
export function fontClasses(settings: KitSettings): string {
  return [...new Set([FONT_CLASSES[settings.tokens.fonts.heading], FONT_CLASSES[settings.tokens.fonts.body]])].join(" ");
}
