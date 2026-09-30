import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { domains } from "@/modules/domains/schema";
import { siteSettings, sites } from "@/modules/sites/schema";
import { CMS_CACHE_PROFILE, tags } from "@/platform/cache";
import { withPlatform, withTenant } from "@/platform/db/tenant";

/**
 * Spike S1 (M0-4, ADR 0002): the public read path under Cache Components.
 * Cached functions take the host / site id as arguments (never headers or
 * cookies) and tag results from the one taxonomy. M4-3 moves this into
 * modules/rendering.
 */

export async function resolveSiteByHost(host: string) {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  cacheTag(tags.host(host));
  const [row] = await withPlatform((tx) =>
    tx
      .select({ siteId: domains.siteId, orgId: domains.organizationId })
      .from(domains)
      .where(and(eq(domains.hostname, host), eq(domains.status, "active"))),
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
