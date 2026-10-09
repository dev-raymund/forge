import type { ComponentType, ReactNode } from "react";
import type { z } from "zod";
import type { FooterVariant, HeaderVariant, KitSettings } from "./_kit/tokens";

/**
 * The contracts between themes and the rest of Forge (plan §7, ADR 0012).
 *
 * A theme is code in this repository: a definition (what the admin and the
 * settings validation need, ./registry.ts) and a manifest (that, plus the
 * React components the public renderer draws with, ./render.ts). Tenants
 * choose a theme and set its settings; they never supply code (D-25).
 */

/** What every theme must say about itself. Pure data: the admin's picker and the settings validation read only this. */
export type ThemeDefinition<K extends string = string> = {
  /** Stable: stored in `sites.theme_key`. */
  readonly key: K;
  readonly name: string;
  readonly description: string;
  /** The theme's own settings version, for a future `migrateSettings` (plan §7). */
  readonly version: number;
  /** The kit-level settings a site of this theme starts with. What the site has saved overrides them, value by value. */
  readonly defaults: KitSettings;
  /** The theme's own extra settings (`site_settings.theme.options[key]`). Strict: unknown keys are refused. */
  readonly options: z.ZodType<Record<string, unknown>>;
  /** The header and footer variants it draws. A saved variant it does not have falls back to the first. */
  readonly headerVariants: readonly [HeaderVariant, ...HeaderVariant[]];
  readonly footerVariants: readonly [FooterVariant, ...FooterVariant[]];
  /** How the picker sketches it: a business site or a publication. */
  readonly preview: "business" | "editorial";
};

/** The page templates every theme has in M4-4. M5-6 adds post, blog index and archives; M8-2 Journal's. */
export const TEMPLATE_KEYS = ["page", "coming-soon", "not-found"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/** A link in a menu. Menus arrive in M8-3; until then the lists are empty. */
export type NavItem = { readonly label: string; readonly href: string };

/**
 * Everything a theme may know when it draws a page, handed to it by the
 * renderer. Public data only: no session, no member, no organization id, no
 * database handle. Links are built from `basePath` (`/s/{address}` in V1, ""
 * on a site's own host later, ADR 0006).
 */
export type ThemeContext = {
  readonly site: {
    readonly name: string;
    readonly tagline: string;
    readonly language: string;
    readonly basePath: string;
    /** The site's social links (M4-2), already validated as `https` addresses. Drawn when `settings.footer.showSocial`. */
    readonly social: readonly NavItem[];
  };
  /** The site's settings for this theme, already read through the schema (./_kit/tokens.ts `readThemeSettings`). */
  readonly settings: KitSettings;
  readonly options: Readonly<Record<string, unknown>>;
  readonly menus: { readonly header: readonly NavItem[]; readonly footer: readonly NavItem[] };
};

export type TemplateProps = {
  page: { context: ThemeContext; title: string; children?: ReactNode };
  "coming-soon": { context: ThemeContext };
  "not-found": { context: ThemeContext };
};

/** A definition, with what the public renderer draws: the frame of every page, and each template. */
export type ThemeManifest<K extends string = string> = ThemeDefinition<K> & {
  readonly Layout: ComponentType<{ context: ThemeContext; children: ReactNode }>;
  readonly templates: { readonly [T in TemplateKey]: ComponentType<TemplateProps[T]> };
};
