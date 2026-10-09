import { journal } from "./journal/definition";
import { studio } from "./studio/definition";
import type { ThemeDefinition } from "./types";

/**
 * The themes (plan §7): the one list. Pure and client-safe: the admin's picker,
 * the settings validation and the public renderer (./render.ts) all start
 * here, so a theme's name, description and defaults exist once.
 *
 * Only what is in this list can be chosen or drawn. A key is looked up in it,
 * never turned into a path or a module name: an unknown or hostile key finds
 * nothing. To add a theme: write its folder, add it here (ADR 0012).
 */
export const THEMES = [studio, journal] as const;

export type ThemeKey = (typeof THEMES)[number]["key"];
export const THEME_KEYS = THEMES.map((theme) => theme.key) as [ThemeKey, ...ThemeKey[]];

/** What a new site starts with: the `sites.theme_key` column's default. */
export const DEFAULT_THEME_KEY: ThemeKey = "studio";

export const isThemeKey = (value: unknown): value is ThemeKey => typeof value === "string" && (THEME_KEYS as readonly string[]).includes(value);

/** The definition of a key in the list, or null. */
export function themeDefinition(key: unknown): ThemeDefinition<ThemeKey> | null {
  return THEMES.find((theme) => theme.key === key) ?? null;
}

/**
 * The theme a site is drawn with. A stored key that is not in the list (a theme
 * removed, a damaged row) is drawn with the default instead of failing.
 */
export function activeThemeDefinition(key: unknown): ThemeDefinition<ThemeKey> {
  return themeDefinition(key) ?? themeDefinition(DEFAULT_THEME_KEY)!;
}
