import "server-only";
import { ZodError } from "zod";
import { record } from "@/modules/audit";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { AppError, conflict, fieldErrorsFrom, notFound, validationError } from "@/platform/errors";
import { PREVIEW_PATH_PREFIX, PREVIEW_TOKEN_TTL_SECONDS, previewSecret, signAppearanceToken } from "@/platform/routing/preview-token";
import { activeThemeDefinition, isThemeKey, THEMES, type ThemeKey } from "@/themes/registry";
import type { ThemeDefinition } from "@/themes/types";
import { parseThemeSettings, readThemeSettings, type FooterVariant, type HeaderVariant, type KitSettings, type ThemeSettings } from "@/themes/_kit/tokens";
import { findSiteRow, readSettingsRow, saveSettings, storedThemeSettings, updateThemeKey } from "./repository";
import { SETTINGS_CONFLICT } from "./settings.service";
import type { SiteSummary } from "./shared";
import { chooseThemeSchema, parseInput, type ChooseThemeInput } from "./validation";

/**
 * A site's appearance (M4-4, ADR 0012): which theme draws it; and (M8-1, ADR 0028) its theme's settings: colours,
 * fonts, header, footer and layout, saved through the theme kit's `parseThemeSettings`, with a live preview of what is
 * not saved yet.
 */

export type ThemeChoice = { key: ThemeKey; name: string; description: string; preview: "business" | "editorial"; colors: KitSettings["tokens"]["colors"] };

export type Appearance = {
  /** The theme the site is drawn with: its stored key, or the default if that key is not in the registry. */
  theme: ThemeKey;
  /** The themes it could be drawn with, from the registry, in its order. */
  themes: ThemeChoice[];
  /** The site's settings as its theme reads them. */
  settings: KitSettings;
  /** M8-1: the settings version (the other settings forms' token too), and the header and footer variants the theme draws. */
  version: number;
  variants: { header: readonly HeaderVariant[]; footer: readonly FooterVariant[] };
};

/** The appearance page's data. Every member who may open the page; the page decides who that is. */
export async function getAppearance(ctx: SiteContext): Promise<Appearance> {
  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    if (!site) throw notFound();
    const theme = activeThemeDefinition(site.theme);
    const stored = await storedThemeSettings(tx, ctx.org.id, site.id);
    const row = await readSettingsRow(tx, ctx.org.id, site.id);
    if (!row) throw notFound();
    return {
      theme: theme.key,
      themes: THEMES.map(({ key, name, description, preview, defaults }) => ({ key, name, description, preview, colors: defaults.tokens.colors })),
      settings: readThemeSettings(stored, theme.defaults),
      version: row.version,
      variants: { header: theme.headerVariants, footer: theme.footerVariants },
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

// ── M8-1: the appearance editor ──────────────────────────────────────────────

/** The groups of the theme's settings the editor saves, as the activity log names them. */
export const APPEARANCE_GROUPS = ["colors", "fonts", "header", "footer", "layout"] as const;
export type AppearanceGroup = (typeof APPEARANCE_GROUPS)[number];

const groupOf = (settings: KitSettings): Record<AppearanceGroup, unknown> => ({
  colors: settings.tokens.colors, fonts: settings.tokens.fonts, header: settings.header, footer: settings.footer, layout: settings.layout,
});

/** Messages for the fields whose own rule says little (a label too long, a line too long). */
const FRIENDLY: Record<string, string> = {
  "header.cta.label": "Give the button a label of 1 to 40 characters.",
  "footer.copyright": "Use at most 200 characters.",
};

/**
 * Submitted settings for the site's theme, checked strictly (`parseThemeSettings`: every group present, every value a
 * closed choice or a strict shape, no unknown key, other themes' stored options kept), and the header and footer
 * variants one the theme draws. A `Validation` error keyed by the field's dotted path otherwise.
 */
function checkedSettings(input: unknown, theme: ThemeDefinition<ThemeKey>, stored: unknown): ThemeSettings {
  let settings: ThemeSettings;
  try {
    settings = parseThemeSettings(input, theme, stored);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const fields = fieldErrorsFrom(error);
    throw validationError(Object.fromEntries(Object.entries(fields).map(([path, messages]) => [path, FRIENDLY[path] ? [FRIENDLY[path]] : messages])));
  }
  const refused: Record<string, string[]> = {};
  if (!theme.headerVariants.includes(settings.header.variant)) refused["header.variant"] = [`${theme.name} has no ${settings.header.variant} header.`];
  if (!theme.footerVariants.includes(settings.footer.variant)) refused["footer.variant"] = [`${theme.name} has no ${settings.footer.variant} footer.`];
  if (Object.keys(refused).length) throw validationError(refused);
  return settings;
}

/** The kit-level settings of a site's theme settings: every group but the themes' own options. */
const kitOf = (settings: ThemeSettings): KitSettings => ({ tokens: settings.tokens, header: settings.header, footer: settings.footer, layout: settings.layout });

export type AppearanceChange = { changed: AppearanceGroup[]; version: number; settings: KitSettings; events: CacheEvent[] };

/**
 * Saves the site's theme settings (M8-1; plan §7): `site.settings.manage` (Owner, Admin), checked as above, written to
 * `site_settings.theme` if the settings are still at the version the page was opened with (the same token the other
 * settings groups use: someone else's save since is a Conflict, and nothing is written), and recorded as a settings
 * change of the "appearance" group with the groups that changed. Nothing changed: nothing is written, recorded or
 * flushed. A change flushes the site's settings (`site:{id}:config`), which every public page is drawn with.
 */
export async function updateAppearance(ctx: SiteContext, input: unknown, version: number): Promise<AppearanceChange> {
  requirePermission(ctx, "site.settings.manage");
  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    const row = site ? await readSettingsRow(tx, ctx.org.id, site.id) : null;
    if (!site || !row) throw notFound();
    const theme = activeThemeDefinition(site.theme);
    const stored = await storedThemeSettings(tx, ctx.org.id, site.id);
    const settings = checkedSettings(input, theme, stored);
    const before = groupOf(readThemeSettings(stored, theme.defaults));
    const after = groupOf(settings);
    const changed = APPEARANCE_GROUPS.filter((group) => JSON.stringify(before[group]) !== JSON.stringify(after[group]));
    const kit = kitOf(settings);
    if (changed.length === 0) return { changed, version: row.version, settings: kit, events: [] };
    const saved = await saveSettings(tx, ctx.org.id, site.id, version, { theme: settings }, ctx.actor.userId);
    if (saved === null) throw conflict(SETTINGS_CONFLICT);
    await record(tx, { action: "site.settings_changed", resourceType: "site", resourceId: site.id, siteId: site.id, metadata: { name: site.name, group: "appearance", fields: changed } }, ctx);
    return { changed, version: saved, settings: kit, events: [{ type: "site.configChanged", siteId: site.id }] };
  });
}

/**
 * A preview of settings that are not saved (M8-1, "a live preview iframe using a preview token with unsaved
 * settings"): the same checks as saving, then a 15-minute preview token (ADR 0027) that carries them, for the person
 * asking, who must still be allowed to change the appearance when the page is opened. Nothing is written.
 */
export async function createAppearancePreview(ctx: SiteContext, input: unknown): Promise<{ path: string; expiresAt: string }> {
  requirePermission(ctx, "site.settings.manage");
  const secret = previewSecret();
  if (!secret) throw new AppError("Unavailable", "Previews are not set up on this server yet.");
  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    if (!site) throw notFound();
    const theme = activeThemeDefinition(site.theme);
    const kit = kitOf(checkedSettings(input, theme, await storedThemeSettings(tx, ctx.org.id, site.id)));
    const expiresAt = Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_TTL_SECONDS;
    const token = signAppearanceToken({ orgId: ctx.org.id, siteId: site.id, userId: ctx.actor.userId, settings: kit, expiresAt }, secret);
    return { path: `${PREVIEW_PATH_PREFIX}/${token}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
  });
}
