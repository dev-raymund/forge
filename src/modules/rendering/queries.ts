import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { CMS_CACHE_PROFILE, tags } from "@/platform/cache";
import { publicImages, siteImagery, type PublicImage, type SiteImagery } from "@/modules/media/public";
import { readSiteSeo, type SiteSeo } from "@/modules/seo/shared";
import { withPlatform, withTenant } from "@/platform/db";
import { domains, siteSettings, sites } from "@/platform/db/schema";
import { isSiteAddress, type SiteLocator } from "@/platform/routing/hosts";
import { readAnalytics, readGeneral, readReading, socialLinks, type AnalyticsSettings, type ReadingSettings } from "@/modules/sites/shared";

/**
 * The public read path (M4-3, ADR 0013; from the M0-4 spike, ADR 0002).
 *
 * Two cached functions, each keyed by what it is given and tagged so the
 * right change flushes it:
 *
 *   resolveSite(locator)            domains: address → site      tag host:{address}       (create, move, delete)
 *   loadPublicSite(orgId, siteId)   sites + site_settings        tags site:{id}, …:config (status, theme, settings)
 *
 * Neither reads a cookie, a header or a session: a visitor's identity cannot
 * change what they return, and the proxy has already stripped credentials
 * from `/s/*` requests (ADR 0006).
 */

export type ResolvedSite = { siteId: string; orgId: string; isPrimary: boolean };

/**
 * The site at an address (V1) or, post-V1, a hostname. `domains` is a
 * platform table, read before any tenant is known. A deleted site has no
 * `domains` rows (ADR 0011), so its old address finds nothing.
 */
export async function resolveSite(locator: SiteLocator): Promise<ResolvedSite | null> {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  const key = locator.kind === "address" ? locator.address : locator.hostname;
  cacheTag(tags.host(key));
  const [row] = await withPlatform((tx) =>
    tx
      .select({ siteId: domains.siteId, orgId: domains.organizationId, isPrimary: domains.isPrimary })
      .from(domains)
      .where(and(eq(domains.hostname, key), eq(domains.kind, locator.kind === "address" ? "subdomain" : "custom"), eq(domains.status, "active"))),
  );
  return row ?? null;
}

/** What a public page may know about a site. No member, no id beyond the site's own, nothing private. */
export type PublicSite = {
  id: string;
  /** For the content reads (./content.ts). Never handed to a theme (`renderableSite`). */
  orgId: string;
  name: string;
  tagline: string;
  status: string;
  language: string;
  timezone: string;
  themeKey: string;
  /** `site_settings.theme` as stored: the theme reads it through its schema (ADR 0012). */
  themeSettings: unknown;
  /** Social links that passed their rules (M4-2). */
  social: { label: string; href: string }[];
  /** Analytics IDs that passed their rules (M4-2). Emitted only on a live site's pages. */
  analytics: AnalyticsSettings;
  /** Where the blog lives and how many posts a list shows (M4-2's reading settings; M5-6 routes by them). */
  reading: ReadingSettings;
  /** The site's logo and favicon (M6-4), when set and still usable images of the site. */
  imagery: SiteImagery;
  /** Its SEO defaults (M8-4), read value by value, and its default social image when it is still usable. */
  seo: SiteSeo;
  defaultOgImage: PublicImage | null;
  /** The page shown, with a 404 status, at an address the site does not have (M8-5); null for the theme's own. Drawn only while published. */
  notFoundEntryId: string | null;
};

/**
 * The site's public data, in its organization's context: RLS confines the read
 * to that organization, and the query names the site as well. A deleted site,
 * or a site that is not the organization's, is null.
 */
export async function loadPublicSite(orgId: string, siteId: string): Promise<PublicSite | null> {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  cacheTag(tags.site(siteId), tags.config(siteId));
  const found = await withTenant({ orgId }, async (tx) => {
    const [row] = await tx
      .select({
        id: sites.id,
        name: sites.name,
        status: sites.status,
        language: sites.defaultLocale,
        timezone: sites.timezone,
        themeKey: sites.themeKey,
        general: siteSettings.general,
        analytics: siteSettings.analytics,
        theme: siteSettings.theme,
        reading: siteSettings.reading,
        logoMediaId: siteSettings.logoMediaId,
        faviconMediaId: siteSettings.faviconMediaId,
        seo: siteSettings.seo,
        notFoundEntryId: siteSettings.notFoundEntryId,
      })
      .from(sites)
      .leftJoin(siteSettings, and(eq(siteSettings.siteId, sites.id), eq(siteSettings.organizationId, sites.organizationId)))
      .where(and(eq(sites.organizationId, orgId), eq(sites.id, siteId), isNull(sites.deletedAt)));
    if (!row) return null;
    // The logo, the favicon and the default social image (M8-4) are media: their trash or restore flushes this read at once (M6-4).
    const seo = readSiteSeo(row.seo);
    const ids = [row.logoMediaId, row.faviconMediaId, seo.defaultOgImageId].filter((id): id is string => !!id);
    if (ids.length) cacheTag(...ids.map(tags.media));
    const imagery = await siteImagery(tx, orgId, siteId, { logo: row.logoMediaId, favicon: row.faviconMediaId });
    // Checked again here, as on save: an id in JSON has no key, so a trashed or deleted image is simply not drawn.
    const defaultOgImage = seo.defaultOgImageId ? ((await publicImages(tx, orgId, siteId, [seo.defaultOgImageId]))[seo.defaultOgImageId] ?? null) : null;
    return { row, imagery, seo, defaultOgImage };
  });
  if (!found) return null;
  const { row, imagery, seo, defaultOgImage } = found;
  const general = readGeneral(row.general);
  return {
    id: row.id,
    orgId,
    name: row.name,
    tagline: general.tagline,
    status: row.status,
    language: row.language,
    timezone: row.timezone,
    themeKey: row.themeKey,
    themeSettings: row.theme ?? {},
    social: socialLinks(general.social).map(({ label, href }) => ({ label, href })),
    analytics: readAnalytics(row.analytics),
    reading: readReading(row.reading),
    imagery,
    seo,
    defaultOgImage,
    notFoundEntryId: row.notFoundEntryId ?? null,
  };
}

/** At most this many sitemaps in the host's robots.txt (each line is ~60 bytes; crawlers read the first 500 KB). */
export const ROBOTS_SITES_MAX = 5_000;

/**
 * The public addresses of the sites the app host's robots.txt lists (M8-4, path mode): live, not deleted, with an
 * active platform address, not discouraging indexing, in every organization. Read through a lookup function that
 * returns the address and nothing else (migration 0015); cached under `robots`, flushed when a site goes live or
 * back, changes address, or changes its SEO defaults. Keyed by the host whose robots.txt it is: in path mode (V1)
 * every site lives on the app's own host; host mode (post-V1) gives each site's host its own.
 */
export async function indexableSiteAddresses(host: string): Promise<string[]> {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  cacheTag(tags.robots(), tags.host(host));
  const { rows } = await withPlatform((tx) => tx.execute<{ address: string }>(sql`select address from indexable_site_addresses(${ROBOTS_SITES_MAX})`));
  return rows.map((row) => row.address).filter(isSiteAddress);
}
