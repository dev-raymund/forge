import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, oneOf, siteColumns, tenantPolicy, textEnum } from "@/platform/db/columns";
import { users } from "@/modules/auth/schema";
import { siteForeignKey } from "@/modules/sites/schema";

export const API_KEY_SCOPES = ["read", "write"] as const;

/**
 * api_keys — site-bound in V1 (v1-build-plan §15). Only the SHA-256 of the
 * secret is stored. Resolved before the tenant is known through the
 * resolve_api_key() SECURITY DEFINER function (ADR 0001). Class: tenant.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    ...siteColumns(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    secretHash: text("secret_hash").notNull().unique(),
    scope: textEnum("scope", API_KEY_SCOPES).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    siteForeignKey("api_keys", t),
    oneOf("api_keys_scope_check", t.scope, API_KEY_SCOPES),
    index("api_keys_site_idx").on(t.siteId),
    tenantPolicy("api_keys"),
  ],
).enableRLS();
