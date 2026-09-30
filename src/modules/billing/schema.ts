import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { oneOf, tenantPolicy, textEnum, timestamps } from "@/platform/db/columns";
import { organizations } from "@/modules/tenancy/schema";

export const PLAN_KEYS = ["free", "pro"] as const;
export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled", "free"] as const;

/**
 * subscriptions — 1:1 with the organization (v1-build-plan §14). No billing
 * events table: every Stripe webhook re-fetches the subscription and upserts,
 * which is idempotent and order-independent. Class: tenant.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planKey: textEnum("plan_key", PLAN_KEYS).notNull().default("pro"),
    status: textEnum("status", SUBSCRIPTION_STATUSES).notNull().default("trialing"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    oneOf("subscriptions_plan_check", t.planKey, PLAN_KEYS),
    oneOf("subscriptions_status_check", t.status, SUBSCRIPTION_STATUSES),
    tenantPolicy("subscriptions"),
  ],
).enableRLS();
