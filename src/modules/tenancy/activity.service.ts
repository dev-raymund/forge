import "server-only";
import { queryActivity, type ActivityPage, type ActivityQuery } from "@/modules/audit";
import { inTenant, type OrgContext } from "./context";
import { requirePermission } from "./policies";
import { findMember } from "./repository";

/**
 * An organization's activity log, for its members who may read it (M3-5).
 *
 * The audit module writes and reads the rows; who may read them is decided
 * here, where contexts and permissions live. The check is in this function,
 * not only in the page that calls it: `org.activity.read` (Owner and Admin).
 *
 * The organization is the context's. Nothing in `query` can name another one:
 * the filters narrow what is shown inside it, and a member to filter by is
 * looked up among this organization's members.
 */
export async function listActivity(ctx: OrgContext, query: ActivityQuery = {}): Promise<ActivityPage> {
  requirePermission(ctx, "org.activity.read");
  return inTenant(ctx, async (tx) => {
    const { member, ...filters } = query;
    if (!member) return queryActivity(tx, ctx.org.id, filters);
    // A membership id that is not one of this organization's matches nobody's events, rather than everybody's.
    const who = await findMember(tx, ctx.org.id, member);
    if (!who) return { items: [], nextCursor: null };
    return queryActivity(tx, ctx.org.id, { ...filters, actorId: who.userId });
  });
}
