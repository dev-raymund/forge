import "server-only";
import { record } from "@/modules/audit";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { conflict, notFound } from "@/platform/errors";
import { findSiteRow, readSettingsRow, saveSettings, updateSiteColumns, type SettingsPatch } from "./repository";
import {
  analyticsSettingsSchema, generalSettingsSchema, readAnalytics, readGeneral, readingSettingsSchema, readReading, SOCIAL_KEYS,
  type AnalyticsSettings, type GeneralSettings, type ReadingSettings,
} from "./settings";
import { parseInput } from "./validation";

/**
 * A site's settings (M4-2, ADR 0014): general, reading and analytics.
 *
 * Saving is: the permission (`site.settings.manage`, Owner and Admin), the
 * group's strict schema, then one transaction that writes the group if the
 * settings are still at the version the person loaded, the site's own columns
 * for the general group, and the record of what changed. Nothing changed:
 * nothing is written, recorded or flushed. The public site's settings cache
 * (`site:{id}:config`) is flushed by the Server Action after the commit.
 */

export const SETTINGS_GROUPS = ["general", "reading", "analytics"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];
export const isSettingsGroup = (value: unknown): value is SettingsGroup => typeof value === "string" && (SETTINGS_GROUPS as readonly string[]).includes(value);

export type SiteSettingsView = { version: number; general: GeneralSettings; reading: ReadingSettings; analytics: AnalyticsSettings };

export const SETTINGS_CONFLICT =
  "These settings were changed somewhere else since you opened this page. Reload the page to see them, then make your change again.";

/** The settings as the site's pages read them: stored values that pass their rules, the defaults for the rest. */
export async function getSiteSettings(ctx: SiteContext): Promise<SiteSettingsView> {
  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    const row = site ? await readSettingsRow(tx, ctx.org.id, site.id) : null;
    if (!site || !row) throw notFound();
    const general = readGeneral(row.general);
    return {
      version: row.version,
      general: { name: site.name, tagline: general.tagline, language: site.language, timezone: site.timezone, social: general.social },
      reading: readReading(row.reading),
      analytics: readAnalytics(row.analytics),
    };
  });
}

/** Flat, comparable values of a group: what the form shows, and what a change is measured against. */
function flat(group: SettingsGroup, view: SiteSettingsView): Record<string, string | number> {
  if (group === "general") {
    const { social, ...rest } = view.general;
    return { ...rest, ...Object.fromEntries(SOCIAL_KEYS.map((key) => [key, social[key] ?? ""])) };
  }
  if (group === "reading") return { ...view.reading };
  return { ga4MeasurementId: view.analytics.ga4MeasurementId ?? "", plausibleDomain: view.analytics.plausibleDomain ?? "" };
}

export type SettingsChange = { changed: string[]; version: number; settings: SiteSettingsView; events: CacheEvent[] };

/**
 * Saves one group. `version` is the one the person's page was rendered with:
 * if someone else saved since, this refuses with `Conflict` and writes nothing.
 */
export async function updateSiteSettings(ctx: SiteContext, group: SettingsGroup, input: Record<string, unknown>, version: number): Promise<SettingsChange> {
  requirePermission(ctx, "site.settings.manage");
  const schema = group === "general" ? generalSettingsSchema : group === "reading" ? readingSettingsSchema : analyticsSettingsSchema;
  const parsed = parseInput(schema, input) as Record<string, unknown>;

  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    const row = site ? await readSettingsRow(tx, ctx.org.id, site.id) : null;
    if (!site || !row) throw notFound();
    const general = readGeneral(row.general);
    const before: SiteSettingsView = {
      version: row.version,
      general: { name: site.name, tagline: general.tagline, language: site.language, timezone: site.timezone, social: general.social },
      reading: readReading(row.reading),
      analytics: readAnalytics(row.analytics),
    };

    const after: SiteSettingsView = structuredClone(before);
    let patch: SettingsPatch;
    if (group === "general") {
      const social = Object.fromEntries(SOCIAL_KEYS.flatMap((key) => (parsed[key] ? [[key, parsed[key] as string]] : [])));
      after.general = { name: parsed.name as string, tagline: parsed.tagline as string, language: parsed.language as string, timezone: parsed.timezone as string, social };
      // The group is rewritten whole from the schema's output: keys of an older shape do not linger.
      patch = { general: { tagline: after.general.tagline, social } };
    } else if (group === "reading") {
      after.reading = { blogPath: parsed.blogPath as string, postsPerPage: parsed.postsPerPage as number };
      patch = { reading: { ...after.reading } };
    } else {
      after.analytics = {
        ...(parsed.ga4MeasurementId ? { ga4MeasurementId: parsed.ga4MeasurementId as string } : {}),
        ...(parsed.plausibleDomain ? { plausibleDomain: parsed.plausibleDomain as string } : {}),
      };
      patch = { analytics: { ...after.analytics } };
    }

    const [was, now] = [flat(group, before), flat(group, after)];
    const changed = Object.keys(now).filter((key) => was[key] !== now[key]);
    if (changed.length === 0) return { changed, version: row.version, settings: before, events: [] };

    const saved = await saveSettings(tx, ctx.org.id, site.id, version, patch, ctx.actor.userId);
    if (saved === null) throw conflict(SETTINGS_CONFLICT);
    if (group === "general") await updateSiteColumns(tx, ctx.org.id, site.id, after.general);
    await record(
      tx,
      { action: "site.settings_changed", resourceType: "site", resourceId: site.id, siteId: site.id, metadata: { name: after.general.name, group, fields: changed } },
      ctx,
    );
    return { changed, version: saved, settings: { ...after, version: saved }, events: [{ type: "site.configChanged", siteId: site.id }] };
  });
}
