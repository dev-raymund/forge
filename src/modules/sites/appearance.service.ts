import "server-only";
import { record } from "@/modules/audit";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { notFound } from "@/platform/errors";
import { activeThemeDefinition, isThemeKey, THEMES, type ThemeKey } from "@/themes/registry";
import { readThemeSettings, type KitSettings } from "@/themes/_kit/tokens";
import { findSiteRow, storedThemeSettings, updateThemeKey } from "./repository";
import type { SiteSummary } from "./shared";
import { chooseThemeSchema, parseInput, type ChooseThemeInput } from "./validation";

/**
 * A site's appearance (M4-4, ADR 0012): which theme draws it. Customising the
 * theme's settings (colours, fonts, header, footer, layout) is M8-1's; the
 * schema it will save through is `parseThemeSettings` in the theme kit.
 */

export type ThemeChoice = { key: ThemeKey; name: string; description: string; preview: "business" | "editorial"; colors: KitSettings["tokens"]["colors"] };

export type Appearance = {
  /** The theme the site is drawn with: its stored key, or the default if that key is not in the registry. */
  theme: ThemeKey;
  /** The themes it could be drawn with, from the registry, in its order. */
  themes: ThemeChoice[];
  /** The site's settings as its theme reads them. */
  settings: KitSettings;
};

/** The appearance page's data. Every member who may open the page; the page decides who that is. */
export async function getAppearance(ctx: SiteContext): Promise<Appearance> {
  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    if (!site) throw notFound();
    const theme = activeThemeDefinition(site.theme);
    const stored = await storedThemeSettings(tx, ctx.org.id, site.id);
    return {
      theme: theme.key,
      themes: THEMES.map(({ key, name, description, preview, defaults }) => ({ key, name, description, preview, colors: defaults.tokens.colors })),
      settings: readThemeSettings(stored, theme.defaults),
    };
  });
}

/**
 * Draws the site with another theme (plan Phase 4: `chooseTheme`), and records
 * it. `site.settings.manage`: Owners and Admins.
 *
 * Only `sites.theme_key` changes. The site's settings stay as they are: the
 * kit-level ones (colours, fonts, header, footer, layout) are every theme's,
 * so the branding carries over, and each theme's own options are kept under
 * its key, so switching back restores them (plan §7). Content is the content
 * module's and is not touched. Choosing the theme the site already has
 * changes and records nothing.
 *
 * The public site's cache for the site is flushed (`site:{id}`, plan §20:
 * "site status or theme switch").
 */
export async function chooseTheme(ctx: SiteContext, input: ChooseThemeInput): Promise<{ site: SiteSummary; changed: boolean; events: CacheEvent[] }> {
  requirePermission(ctx, "site.settings.manage");
  const { theme } = parseInput(chooseThemeSchema, input);
  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    if (!site) throw notFound();
    if (site.theme === theme) return { site, changed: false, events: [] };
    if (!(await updateThemeKey(tx, ctx.org.id, site.id, theme))) throw notFound();
    // The previous key is recorded as it was stored, even one the registry no longer knows.
    const previousTheme = isThemeKey(site.theme) ? site.theme : site.theme.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "unknown";
    await record(tx, { action: "site.theme_changed", resourceType: "site", resourceId: site.id, siteId: site.id, metadata: { name: site.name, previousTheme, newTheme: theme } }, ctx);
    // `site.statusChanged` is the event for the site umbrella tag: "coming soon ↔ live ↔ suspended, theme switch" (platform/cache/events.ts).
    return { site: { ...site, theme }, changed: true, events: [{ type: "site.statusChanged", siteId: site.id }] };
  });
}
