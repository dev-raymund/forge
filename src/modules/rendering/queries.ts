import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { CMS_CACHE_PROFILE, tags } from "@/platform/cache";
import { withPlatform, withTenant } from "@/platform/db";
import { domains, siteSettings, sites } from "@/platform/db/schema";
import type { SiteLocator } from "@/platform/routing/hosts";

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
  name: string;
  tagline: string;
  status: string;
  language: string;
  timezone: string;
  themeKey: string;
  /** `site_settings.theme` as stored: the theme reads it through its schema (ADR 0012). */
  themeSettings: unknown;
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
  const [row] = await withTenant({ orgId }, (tx) =>
    tx
      .select({
        id: sites.id,
        name: sites.name,
        status: sites.status,
        language: sites.defaultLocale,
        timezone: sites.timezone,
        themeKey: sites.themeKey,
        general: siteSettings.general,
        theme: siteSettings.theme,
      })
      .from(sites)
      .leftJoin(siteSettings, and(eq(siteSettings.siteId, sites.id), eq(siteSettings.organizationId, sites.organizationId)))
      .where(and(eq(sites.organizationId, orgId), eq(sites.id, siteId), isNull(sites.deletedAt))),
  );
  if (!row) return null;
  const tagline = (row.general as { tagline?: unknown } | null)?.tagline;
  return {
    id: row.id,
    name: row.name,
    tagline: typeof tagline === "string" ? tagline.trim().slice(0, 200) : "",
    status: row.status,
    language: row.language,
    timezone: row.timezone,
    themeKey: row.themeKey,
    themeSettings: row.theme ?? {},
  };
}
