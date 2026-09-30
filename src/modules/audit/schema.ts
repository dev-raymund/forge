import { sql } from "drizzle-orm";
import { index, jsonb, pgPolicy, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, oneOf, textEnum } from "@/platform/db/columns";

export const ACTOR_TYPES = ["user", "api_key", "system"] as const;

/**
 * audit_logs — append-only (D-30): forge_app has INSERT and SELECT only
 * (hand-written grant migration). No foreign keys: the log outlives what it
 * describes. Rows with a NULL organization_id are platform events (e.g. login)
 * and are never visible in a tenant context. Class: tenant.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    organizationId: uuid("organization_id"),
    siteId: uuid("site_id"),
    actorType: textEnum("actor_type", ACTOR_TYPES).notNull(),
    actorId: uuid("actor_id"),
    actorLabel: text("actor_label").notNull().default(""),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull().default(""),
    resourceId: uuid("resource_id"),
    requestId: text("request_id").notNull().default(""),
    ip: text("ip").notNull().default(""),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    oneOf("audit_logs_actor_type_check", t.actorType, ACTOR_TYPES),
    index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("audit_logs_org_resource_idx").on(t.organizationId, t.resourceType, t.resourceId),
    pgPolicy("audit_logs_tenant_isolation", {
      as: "permissive",
      for: "all",
      to: "public",
      using: sql`organization_id = app_current_org_id()`,
      // Platform events (no organization) may be written without a tenant context.
      withCheck: sql`organization_id is null or organization_id = app_current_org_id()`,
    }),
  ],
).enableRLS();
