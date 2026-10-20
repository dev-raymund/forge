import "server-only";
import { record } from "@/modules/audit";
import { imagePreviews, usableImageIds, type ImagePreview } from "@/modules/media";
import { readSiteSeo, siteSeoSchema, type SiteSeo } from "@/modules/seo/shared";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { conflict, notFound, validationError } from "@/platform/errors";
import { findSiteRow, readSettingsRow, saveSettings } from "./repository";
import { SETTINGS_CONFLICT } from "./settings.service";
import { parseInput } from "./validation";

/**
 * A site's SEO defaults (M8-4; plan §10, §19 `/…/seo`; ADR 0031): `site.seo.manage`, Owners, Admins and Editors.
 * Stored in `site_settings.seo`, at the settings version the other groups use (someone else's save since is a
 * Conflict), recorded as a settings change of the "seo" group, and flushed with `site.seoChanged` (the site's pages
 * and the host's robots.txt, which leaves out a site that discourages indexing).
 */

export type SeoSettingsView = {
  version: number;
  seo: SiteSeo;
  /** The default social image as the editor shows it, while it is a usable image of the site; null otherwise. */
  defaultOgImage: ImagePreview | null;
  site: { name: string; status: string };
};

const FIELDS = ["titleTemplate", "defaultDescription", "defaultOgImage", "discourageIndexing", "searchConsoleToken"] as const;
const flat = (seo: SiteSeo) => ({
  titleTemplate: seo.titleTemplate,
  defaultDescription: seo.defaultDescription,
  defaultOgImage: seo.defaultOgImageId ?? "",
  discourageIndexing: seo.discourageIndexing,
  searchConsoleToken: seo.searchConsoleToken,
});

export async function getSeoSettings(ctx: SiteContext): Promise<SeoSettingsView> {
  requirePermission(ctx, "site.seo.manage");
  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    const row = site ? await readSettingsRow(tx, ctx.org.id, site.id) : null;
    if (!site || !row) throw notFound();
    const seo = readSiteSeo(row.seo);
    const previews = seo.defaultOgImageId ? await imagePreviews(tx, ctx.org.id, site.id, [seo.defaultOgImageId]) : {};
    return { version: row.version, seo, defaultOgImage: seo.defaultOgImageId ? (previews[seo.defaultOgImageId] ?? null) : null, site: { name: site.name, status: site.status } };
  });
}

export type SeoSettingsChange = { changed: string[]; version: number; seo: SiteSeo; events: CacheEvent[] };

/**
 * Saves the SEO defaults: checked strictly (`siteSeoSchema`: the title template holds `%title%` and known tokens only,
 * plain text, a Search Console token of letters, digits, `-` and `_`); a new default social image must be a usable
 * image of this site (ready, not in the trash: a PDF, another site's image or a missing one is refused). The same
 * values again change nothing.
 */
export async function updateSeoSettings(ctx: SiteContext, input: unknown, version: number): Promise<SeoSettingsChange> {
  requirePermission(ctx, "site.seo.manage");
  const after = parseInput(siteSeoSchema, input);
  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    const row = site ? await readSettingsRow(tx, ctx.org.id, site.id) : null;
    if (!site || !row) throw notFound();
    const before = readSiteSeo(row.seo);
    if (after.defaultOgImageId && after.defaultOgImageId !== before.defaultOgImageId) {
      const usable = await usableImageIds(tx, ctx.org.id, site.id, [after.defaultOgImageId]);
      if (!usable.has(after.defaultOgImageId)) throw validationError({ defaultOgImageId: ["Choose an image of this site."] });
    }
    const [was, now] = [flat(before), flat(after)];
    const changed = FIELDS.filter((key) => was[key] !== now[key]);
    if (changed.length === 0) return { changed, version: row.version, seo: before, events: [] };
    const saved = await saveSettings(tx, ctx.org.id, site.id, version, { seo: { ...after } }, ctx.actor.userId);
    if (saved === null) throw conflict(SETTINGS_CONFLICT);
    await record(tx, { action: "site.settings_changed", resourceType: "site", resourceId: site.id, siteId: site.id, metadata: { name: site.name, group: "seo", fields: changed } }, ctx);
    return { changed, version: saved, seo: after, events: [{ type: "site.seoChanged", siteId: site.id }] };
  });
}
