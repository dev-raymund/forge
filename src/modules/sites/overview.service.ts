import "server-only";
import { inTenant, type SiteContext } from "@/modules/tenancy";
import { env } from "@/platform/config/env";
import { notFound } from "@/platform/errors";
import { activeThemeDefinition } from "@/themes/registry";
import { launchChecklist, type ChecklistItem } from "./overview";
import { canManageSiteSettings } from "./policies";
import { publicSitePath, siteSettingsPath } from "./paths";
import { findSiteRow, launchCounts, readSettingsRow } from "./repository";
import { readAnalytics, readGeneral, readReading, type ReadingSettings } from "./settings";
import type { SiteSummary } from "./shared";

/**
 * A site's overview (M4-2): what it is, how it is set up, and what is left
 * before launch, all read from the database in one transaction. Every member
 * may open it (plan §19: Viewer); the page decides which links to offer.
 */
export type SiteOverview = {
  site: SiteSummary;
  /** The site's public address in full, as visitors type it: APP_ORIGIN + /s/{address} (ADR 0006). */
  publicUrl: string | null;
  theme: { key: string; name: string };
  tagline: string;
  reading: ReadingSettings;
  analytics: { ga4: boolean; plausible: boolean };
  socialLinks: number;
  checklist: ChecklistItem[];
};

/** The one origin of V1 (ADR 0006) and the site's path on it. Never the admin slug. */
export const publicSiteUrl = (address: string): string => `${env("core").APP_ORIGIN.replace(/\/$/, "")}${publicSitePath(address)}`;

export async function getSiteOverview(ctx: SiteContext): Promise<SiteOverview> {
  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    const settings = site ? await readSettingsRow(tx, ctx.org.id, site.id) : null;
    if (!site || !settings) throw notFound();
    const counts = await launchCounts(tx, ctx.org.id, site.id);
    const general = readGeneral(settings.general);
    const analytics = readAnalytics(settings.analytics);
    const seo = settings.seo;
    const seoConfigured = typeof seo === "object" && seo !== null && Object.values(seo).some((value) => value !== "" && value !== null && value !== undefined);
    const theme = activeThemeDefinition(site.theme);
    return {
      site,
      publicUrl: site.address ? publicSiteUrl(site.address) : null,
      theme: { key: theme.key, name: theme.name },
      tagline: general.tagline,
      reading: readReading(settings.reading),
      analytics: { ga4: Boolean(analytics.ga4MeasurementId), plausible: Boolean(analytics.plausibleDomain) },
      socialLinks: Object.keys(general.social).length,
      checklist: launchChecklist(
        { ...counts, seoConfigured, hasAddress: Boolean(site.address), status: site.status },
        {
          settings: siteSettingsPath(ctx.org.slug, ctx.site.slug),
          publicSite: site.address ? publicSitePath(site.address) : null,
          // The overview's own Publish button (M4-5), for those who have it.
          publish: canManageSiteSettings(ctx) ? "#publish" : null,
        },
      ),
    };
  });
}
