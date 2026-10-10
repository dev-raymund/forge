import "server-only";
import { record } from "@/modules/audit";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { conflict, forbidden, notFound } from "@/platform/errors";
import { statusTransition, SITE_UNAVAILABLE, VERIFY_TO_PUBLISH, type SettableStatus } from "./publishing";
import { findSiteRow, lockSiteStatus, updateSiteStatus } from "./repository";
import type { SiteSummary } from "./shared";
import { parseInput, setSiteStatusSchema } from "./validation";

/**
 * Publishing a site, and taking it back to Coming soon (M4-5, ADR 0015;
 * plan Phase 4 `setSiteStatus`). `site.settings.manage` ("… publish site",
 * Owner and Admin); going live also needs a verified email address (plan §2).
 *
 * In one transaction: the site's row is locked, the transition checked
 * against its status as it is now, the status written, and the change
 * recorded. Asking for the status the site already has changes, records and
 * flushes nothing, so a repeated or late submission cannot record twice. The
 * public site's `site:{id}` tag is flushed by the Server Action after the commit.
 */
export async function setSiteStatus(ctx: SiteContext, input: { status: string }): Promise<{ site: SiteSummary; changed: boolean; events: CacheEvent[] }> {
  requirePermission(ctx, "site.settings.manage");
  const { status } = parseInput(setSiteStatusSchema, input);
  if (status === "live" && !ctx.actor.emailVerified) throw forbidden(VERIFY_TO_PUBLISH);

  return inTenant(ctx, async (tx) => {
    const current = await lockSiteStatus(tx, ctx.org.id, ctx.site.id);
    if (current === null) throw notFound();
    const site = (await findSiteRow(tx, ctx.org.id, ctx.site.id))!;
    const transition = statusTransition(current, status as SettableStatus);
    if (transition === "refused") throw conflict(SITE_UNAVAILABLE);
    if (transition === "unchanged") return { site, changed: false, events: [] };

    await updateSiteStatus(tx, ctx.org.id, site.id, status);
    await record(
      tx,
      {
        action: "site.status_changed", resourceType: "site", resourceId: site.id, siteId: site.id,
        metadata: { name: site.name, previousStatus: current as "coming_soon" | "live", newStatus: status },
      },
      ctx,
    );
    // The site's umbrella tag: the renderer reads the status under it (ADR 0013).
    return { site: { ...site, status }, changed: true, events: [{ type: "site.statusChanged", siteId: site.id }] };
  });
}
