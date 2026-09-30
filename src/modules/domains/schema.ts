import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { id, oneOf, siteColumns, textEnum, timestamps } from "@/platform/db/columns";
import { siteForeignKey } from "@/modules/sites/schema";

export const DOMAIN_KINDS = ["subdomain", "custom"] as const;
export const DOMAIN_STATUSES = ["pending_verification", "pending_dns", "active", "failed"] as const;

/**
 * domains — class: platform (no RLS). Hostnames are public (DNS is public) and
 * host → site resolution must happen before the tenant is known. Only the
 * domains module and the renderer's host resolver read or write it.
 */
export const domains = pgTable(
  "domains",
  {
    id: id(),
    ...siteColumns(),
    hostname: text("hostname").notNull().unique(),
    kind: textEnum("kind", DOMAIN_KINDS).notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    status: textEnum("status", DOMAIN_STATUSES).notNull(),
    verificationToken: text("verification_token"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    providerState: jsonb("provider_state").$type<Record<string, unknown>>().notNull().default({}),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    error: text("error"),
    ...timestamps(),
  },
  (t) => [
    siteForeignKey("domains", t),
    oneOf("domains_kind_check", t.kind, DOMAIN_KINDS),
    oneOf("domains_status_check", t.status, DOMAIN_STATUSES),
    check(
      "domains_hostname_normalised",
      sql`${sql.identifier("hostname")} = lower(${sql.identifier("hostname")}) and ${sql.identifier("hostname")} !~ '[.:]$|:'`,
    ),
    uniqueIndex("domains_one_primary_per_site").on(t.siteId).where(sql`is_primary`),
    index("domains_site_idx").on(t.siteId),
    index("domains_next_check_idx")
      .on(t.nextCheckAt)
      .where(sql`status in ('pending_verification', 'pending_dns')`),
  ],
);
