import { journalTheme } from "./journal/theme";
import { activeThemeDefinition, type ThemeKey } from "./registry";
import { studioTheme } from "./studio/theme";
import { readThemeOptions, readThemeSettings } from "./_kit/tokens";
import type { NavItem, ThemeContext, ThemeManifest } from "./types";

/**
 * The themes as the public renderer uses them (M4-3 onward): each key of the
 * registry with its components. Only the site renderer imports this file, so
 * no theme's components or CSS ever reach the admin.
 *
 * A key is looked up in this map and in nothing else. A key the registry
 * does not know is drawn with the default theme (`activeThemeDefinition`).
 */
const MANIFESTS: { readonly [K in ThemeKey]: ThemeManifest<K> } = { studio: studioTheme, journal: journalTheme };

export function themeManifest(key: unknown): ThemeManifest {
  return MANIFESTS[activeThemeDefinition(key).key];
}

/** What the renderer knows about a site, as M4-3's queries will read it. Nothing in here comes from a visitor. */
export type RenderableSite = {
  name: string;
  tagline?: string | null;
  language: string;
  basePath: string;
  themeKey: string;
  /** `site_settings.theme` as stored: read through the schema here, so a damaged value falls back to the theme's default. */
  themeSettings: unknown;
  menus?: { header?: readonly NavItem[]; footer?: readonly NavItem[] };
};

/** The theme a site is drawn with, and the context its components receive. */
export function themeFor(site: RenderableSite): { theme: ThemeManifest; context: ThemeContext } {
  const theme = themeManifest(site.themeKey);
  const context: ThemeContext = {
    site: { name: site.name, tagline: site.tagline ?? "", language: site.language, basePath: site.basePath },
    settings: readThemeSettings(site.themeSettings, theme.defaults),
    options: readThemeOptions(site.themeSettings, theme),
    menus: { header: site.menus?.header ?? [], footer: site.menus?.footer ?? [] },
  };
  return { theme, context };
}
