import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, oneOf, softDelete, tenantPolicy, textEnum, timestamps } from "@/platform/db/columns";
import { users } from "@/modules/auth/schema";

export const ORGANIZATION_STATUSES = ["active", "suspended"] as const;
export const ROLE_KEYS = ["owner", "admin", "editor", "author", "viewer"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/**
 * organizations — class: membership. Visible inside its own tenant context, or
 * to a user who is a member (so the org switcher works before an org is chosen).
 */
export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    status: textEnum("status", ORGANIZATION_STATUSES).notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    oneOf("organizations_status_check", t.status, ORGANIZATION_STATUSES),
    check("organizations_slug_format", sql`${sql.identifier("slug")} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    pgPolicy("organizations_membership", {
      as: "permissive",
      for: "all",
      to: "public",
      using: sql`id = app_current_org_id() or id in (select m.organization_id from organization_members m where m.user_id = app_current_user_id())`,
      withCheck: sql`id = app_current_org_id()`,
    }),
  ],
).enableRLS();

/**
 * roles — reference data (5 system rows seeded by migration, organization_id
 * NULL). Permissions for system roles live in code. Custom roles later are
 * rows with an organization_id (v1-build-plan §4.5). No RLS; forge_app has
 * SELECT only.
 */
export const roles = pgTable(
  "roles",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("roles_org_key_unique").on(t.organizationId, t.key).nullsNotDistinct()],
);

/** organization_members — class: membership. */
export const organizationMembers = pgTable(
  "organization_members",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    unique("organization_members_org_user_unique").on(t.organizationId, t.userId),
    index("organization_members_user_idx").on(t.userId),
    pgPolicy("organization_members_membership", {
      as: "permissive",
      for: "all",
      to: "public",
      using: sql`organization_id = app_current_org_id() or user_id = app_current_user_id()`,
      withCheck: sql`organization_id = app_current_org_id()`,
    }),
  ],
).enableRLS();

/** organization_invitations — class: tenant (+ resolve_invitation() lookup). */
export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("organization_invitations_open_email_unique")
      .on(t.organizationId, t.email)
      .where(sql`accepted_at is null and revoked_at is null`),
    check("organization_invitations_email_lowercase", sql`${sql.identifier("email")} = lower(${sql.identifier("email")})`),
    tenantPolicy("organization_invitations"),
  ],
).enableRLS();
