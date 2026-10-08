import "server-only";
import type { TenantTx } from "@/platform/db";
import { subscriptions } from "./schema";

/**
 * Public server API of the billing module. Stripe arrives with M11. Before
 * that: every organization is born with its trial subscription row (M3-1,
 * plan §3: "14-day Pro trial starts"), and the plans' limits are checked when
 * something is created (M4-1: sites).
 */

export { allowanceOf, assertLimit } from "./limits";
export { countOf, hasRoomFor, limitMessage, PLANS } from "./plans";
export type { Allowance, LimitKey, Plan, PlanKey } from "./plans";

export const TRIAL_DAYS = 14;

/** Called by `createOrganization`, inside the transaction that creates the organization. */
export async function startTrial(tx: TenantTx, organizationId: string, now: Date = new Date()): Promise<void> {
  await tx.insert(subscriptions).values({
    organizationId,
    planKey: "pro",
    status: "trialing",
    trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 24 * 3600 * 1000),
  });
}
