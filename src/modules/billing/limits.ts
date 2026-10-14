import "server-only";
import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import type { TenantTx } from "@/platform/db";
import { mediaAssets, organizations, sites } from "@/platform/db/schema";
import { limitExceeded } from "@/platform/errors";
import { hasRoomFor, limitMessage, PLANS, type Allowance, type LimitKey, type PlanKey } from "./plans";
import { subscriptions } from "./schema";

/**
 * Plan limits (plan §14, D-10): "may this organization have one more?".
 *
 * A separate question from "may this person do it?". That is the role's,
 * answered first by the caller with `requirePermission` (ADR 0009). This one
 * is the plan's, and nothing about the person changes it.
 */

/**
 * The plan whose limits apply: the organization's subscription row, which
 * organization creation writes (the Pro trial) and billing keeps up to date
 * (M11: the webhook, and the daily job that ends a trial). No row means no
 * paid plan.
 */
async function planOf(tx: TenantTx, organizationId: string): Promise<PlanKey> {
  const [row] = await tx.select({ plan: subscriptions.planKey }).from(subscriptions).where(eq(subscriptions.organizationId, organizationId));
  return row?.plan ?? "free";
}

/**
 * What counts towards each limit.
 *  - sites: a deleted site no longer does.
 *  - storage: every upload that is not `failed`, its original and its variants (M6-2). A `pending` one counts its
 *    declared size from the moment it is requested (a reservation: `completeUpload` only accepts an object of exactly
 *    that size); its variants count from the moment it becomes `ready`, when their real sizes are checked here. A
 *    trashed one counts until the purge removes its objects. A failed upload, and one the cleanup has expired, gives
 *    its bytes back.
 */
async function usage(tx: TenantTx, organizationId: string, key: LimitKey): Promise<number> {
  switch (key) {
    case "sites": {
      const [row] = await tx.select({ n: count() }).from(sites).where(and(eq(sites.organizationId, organizationId), isNull(sites.deletedAt)));
      return row?.n ?? 0;
    }
    case "storage": {
      const [row] = await tx
        .select({ bytes: sql<string>`coalesce(sum(${mediaAssets.sizeBytes} + ${mediaAssets.variantBytes}), 0)::bigint` })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.organizationId, organizationId), ne(mediaAssets.status, "failed")));
      return Number(row?.bytes ?? 0);
    }
  }
}

/** How much of a limit the organization uses now. For screens: the decision is `assertLimit`'s. */
export async function allowanceOf(tx: TenantTx, organizationId: string, key: LimitKey): Promise<Allowance> {
  const plan = await planOf(tx, organizationId);
  return { plan, key, used: await usage(tx, organizationId, key), limit: PLANS[plan].limits[key] };
}

/**
 * Throws `LimitExceeded` when the organization has no room for `amount` more:
 * one more site, or this many more bytes of storage.
 *
 * Call it in the transaction that creates the thing, before creating it. It
 * locks the organization's row first, so two creations in one organization
 * take turns: the second counts what the first committed, and two requests
 * can never both take the last place (or the last bytes).
 */
export async function assertLimit(tx: TenantTx, organizationId: string, key: LimitKey, amount = 1): Promise<Allowance> {
  await tx.execute(sql`select 1 from ${organizations} where ${organizations.id} = ${organizationId} for update`);
  const allowance = await allowanceOf(tx, organizationId, key);
  if (!hasRoomFor(allowance, amount)) throw limitExceeded(key, limitMessage(allowance));
  return allowance;
}
