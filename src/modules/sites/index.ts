import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "@/platform/db";
import { domains } from "@/platform/db/schema";
import { sites, SITE_STATUSES } from "./schema";

/**
 * Public server API of the sites module. Creating and configuring sites is
 * M4-1; M3-1 needs the read side the tenant resolver stands on.
 *
 * A site has two names, and they are different things:
 *  - its **slug**, unique inside its organization, used in admin URLs
 *    (`/{orgSlug}/sites/{siteSlug}`);
 *  - its **address**, unique on the whole platform, used in public URLs
 *    (`/s/{address}` in V1). It is the `domains` row of kind `subdomain`
 *    (ADR 0006), never the slug.
 */

export type SiteStatus = (typeof SITE_STATUSES)[number];
export type SiteRef = { id: string; organizationId: string; slug: string; name: string; status: SiteStatus };

/**
 * A site of the transaction's organization, by its slug. The organization is
 * also named in the WHERE clause: RLS already confines the query to the
 * tenant, and the query does not depend on it.
 */
export async function findSiteBySlug(tx: TenantTx, organizationId: string, slug: string): Promise<SiteRef | null> {
  const [row] = await tx
    .select({ id: sites.id, organizationId: sites.organizationId, slug: sites.slug, name: sites.name, status: sites.status })
    .from(sites)
    .where(and(eq(sites.organizationId, organizationId), eq(sites.slug, slug), isNull(sites.deletedAt)));
  return row ?? null;
}

/** The site's platform address (`/s/{address}`), or null while it has none. */
export async function siteAddress(tx: TenantTx, site: Pick<SiteRef, "id" | "organizationId">): Promise<string | null> {
  const [row] = await tx
    .select({ hostname: domains.hostname })
    .from(domains)
    .where(and(eq(domains.organizationId, site.organizationId), eq(domains.siteId, site.id), eq(domains.kind, "subdomain")));
  return row?.hostname ?? null;
}
