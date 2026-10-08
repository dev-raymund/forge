import "server-only";
import { record } from "@/modules/audit";
import { allowanceOf, assertLimit, type Allowance } from "@/modules/billing";
import { inTenant, requirePermission, type OrgContext, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { isUniqueViolation } from "@/platform/db";
import { notFound, validationError } from "@/platform/errors";
import { siteSlugFor } from "./address";
import { findSiteRow, insertSite, listSiteRows, siteAddress, slugsInUse, softDeleteSite, updateAddress } from "./repository";
import type { SiteSummary } from "./shared";
import { changeSiteAddressSchema, createSiteSchema, parseInput, type ChangeSiteAddressInput, type CreateSiteInput } from "./validation";

/**
 * Sites (M4-1, ADR 0011): create one, list them, move one to another address,
 * delete one.
 *
 * Every function takes a context from the tenant resolver: the organization,
 * and for site operations the site, come from the URL as checked against the
 * caller's membership, never from input. Each one asks, in this order:
 *
 *   may this person do it?        requirePermission (the role, ADR 0009)
 *   may the organization have it? assertLimit       (the plan, modules/billing)
 *   is the input acceptable?      the shared schema (./validation.ts)
 *   then writes, and records it   record(tx, …)     (same transaction, ADR 0010)
 *
 * A change to what the public sees returns its cache events; the Server Action
 * flushes them after the commit (D-27).
 */

const ADDRESS_TAKEN = "That address is already taken. Choose another.";
/** The unique constraint on `domains.hostname`: the last word on whether an address is free. */
const ADDRESS_UNIQUE = "domains_hostname_unique";

export type SiteChange = { site: SiteSummary; events: CacheEvent[] };

/** The database refused the address because another site holds it: the person is told so, at the field. */
function addressTaken(error: unknown): never {
  if (isUniqueViolation(error, ADDRESS_UNIQUE)) throw validationError({ address: [ADDRESS_TAKEN] });
  throw error;
}

/**
 * Creates a site with its settings and its address, and records it, in one
 * transaction: all of it exists, or none of it does.
 *
 * Two people asking for the same address at once: the unique constraint lets
 * one of them have it, and the other is told it is taken. Two sites created at
 * once in one organization: the limit check locks the organization's row, so
 * they take turns, and the second one counts the first.
 */
export async function createSite(ctx: OrgContext, input: CreateSiteInput): Promise<SiteChange> {
  requirePermission(ctx, "sites.create");
  try {
    return await inTenant(ctx, async (tx) => {
      await assertLimit(tx, ctx.org.id, "sites");
      const { name, address, language, timezone } = parseInput(createSiteSchema, input);
      // Under the organization's lock (taken by assertLimit): no other site of it can take the slug meanwhile.
      const slug = siteSlugFor(address, await slugsInUse(tx, ctx.org.id));
      const site = await insertSite(tx, { organizationId: ctx.org.id, name, slug, language, timezone, createdBy: ctx.actor.userId }, address);
      await record(tx, { action: "site.created", resourceType: "site", resourceId: site.id, siteId: site.id, metadata: { name, address } }, ctx);
      // Someone may have asked for this address before it existed: the cached "no such site" goes.
      return { site, events: [{ type: "domain.changed", siteId: site.id, hostnames: [address] }] };
    });
  } catch (error) {
    addressTaken(error);
  }
}

/** The organization's sites. Every member may see them (plan §19: Viewer). */
export async function listSites(ctx: OrgContext): Promise<SiteSummary[]> {
  return inTenant(ctx, (tx) => listSiteRows(tx, ctx.org.id));
}

/** One site, by the context the resolver made for it. */
export async function getSite(ctx: SiteContext): Promise<SiteSummary> {
  const site = await inTenant(ctx, (tx) => findSiteRow(tx, ctx.org.id, ctx.site.id));
  if (!site) throw notFound();
  return site;
}

/** How many sites the organization has, and how many its plan allows. For screens: `createSite` decides. */
export async function siteAllowance(ctx: OrgContext): Promise<Allowance> {
  return inTenant(ctx, (tx) => allowanceOf(tx, ctx.org.id, "sites"));
}

/**
 * Moves the site to another public address (plan Phase 4: `changeSiteAddress`).
 * The old address stops answering and is free for anyone at once; nothing
 * redirects from it. Asking for the address the site already has changes
 * nothing and records nothing.
 */
export async function changeSiteAddress(ctx: SiteContext, input: ChangeSiteAddressInput): Promise<SiteChange & { changed: boolean }> {
  requirePermission(ctx, "site.settings.manage");
  const { address } = parseInput(changeSiteAddressSchema, input);
  try {
    return await inTenant(ctx, async (tx) => {
      const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
      if (!site) throw notFound();
      // Every site is created with an address (`createSite`); one without is not a site this can move.
      const previous = await siteAddress(tx, { id: site.id, organizationId: ctx.org.id });
      if (!previous) throw notFound();
      if (previous === address) return { site, changed: false, events: [] };
      await updateAddress(tx, ctx.org.id, site.id, address);
      await record(
        tx,
        { action: "site.address_changed", resourceType: "site", resourceId: site.id, siteId: site.id, metadata: { name: site.name, previousAddress: previous, newAddress: address } },
        ctx,
      );
      // Both: the old address must stop answering, and the new one must stop being "no such site".
      return { site: { ...site, address }, changed: true, events: [{ type: "domain.changed", siteId: site.id, hostnames: [previous, address] }] };
    });
  } catch (error) {
    addressTaken(error);
  }
}

/**
 * Deletes the site (soft, plan Phase 4) and records it. Owners only
 * (`sites.delete`). From the commit on, its address answers "not found" and
 * is free for anyone; the site no longer counts towards the plan's limit.
 */
export async function deleteSite(ctx: SiteContext): Promise<SiteChange> {
  requirePermission(ctx, "sites.delete");
  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    if (!site) throw notFound();
    const hostnames = await softDeleteSite(tx, ctx.org.id, site.id);
    if (!hostnames) throw notFound();
    await record(
      tx,
      { action: "site.deleted", resourceType: "site", resourceId: site.id, siteId: site.id, metadata: { name: site.name, address: site.address ?? site.slug } },
      ctx,
    );
    return { site, events: [{ type: "domain.changed", siteId: site.id, hostnames }] };
  });
}
