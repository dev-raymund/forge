import "server-only";
import type { TenantTx } from "@/platform/db";
import { subscriptions } from "./schema";

/**
 * Public server API of the billing module. Stripe, plans and limits arrive
 * with M11; M3-1 needs one thing from here: every organization is born with
 * its trial subscription row (plan §3: "14-day Pro trial starts").
 */

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
