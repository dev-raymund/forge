import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { domains } from "@/modules/domains/schema";
import { siteSettings, sites } from "@/modules/sites/schema";
import { CMS_CACHE_PROFILE, tags } from "@/platform/cache";
import type { SiteLocator } from "@/platform/routing/hosts";
import { withPlatform, withTenant } from "@/platform/db/tenant";

/**
 * Spike S1 (M0-4, ADR 0002): the public read path under Cache Components.
 * Cached functions take the site locator / site id as arguments (never headers
 * or cookies) and tag results from the one taxonomy. M4-3 moves this into
 * modules/rendering.
 */

/**
 * Site resolution for both addressing modes (ADR 0006). A platform address is
 * the `domains` row of kind `subdomain` whose hostname column holds the label;
 * a custom domain is matched by its full hostname. Either way: the site, its
 * organization — and from there the same render path.
 */
export async function resolveSite(locator: SiteLocator) {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  const key = locator.kind === "address" ? locator.address : locator.hostname;
  cacheTag(tags.host(key));
  const [row] = await withPlatform((tx) =>
    tx
      .select({ siteId: domains.siteId, orgId: domains.organizationId })
      .from(domains)
      .where(
        and(
          eq(domains.hostname, key),
          eq(domains.kind, locator.kind === "address" ? "subdomain" : "custom"),
          eq(domains.status, "active"),
        ),
      ),
  );
  return row ?? null;
}

export async function getSiteView(orgId: string, siteId: string) {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  cacheTag(tags.site(siteId), tags.config(siteId));
  const [row] = await withTenant({ orgId }, (tx) =>
    tx
      .select({ name: sites.name, general: siteSettings.general })
      .from(sites)
      .innerJoin(siteSettings, eq(siteSettings.siteId, sites.id))
      .where(eq(sites.id, siteId)),
  );
  if (!row) return null;
  // renderedAt shows when this cache entry was computed (tests assert on it).
  return { name: row.name, tagline: String(row.general.tagline ?? ""), renderedAt: new Date().toISOString() };
}

/** The write side of the spike: what a publish would do before invalidating. */
export async function writeTagline(orgId: string, siteId: string, tagline: string) {
  await withTenant({ orgId }, (tx) =>
    tx
      .update(siteSettings)
      .set({ general: sql`${siteSettings.general} || jsonb_build_object('tagline', ${tagline}::text)` })
      .where(eq(siteSettings.siteId, siteId)),
  );
}
