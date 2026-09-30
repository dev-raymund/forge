import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type PgColumn,
} from "drizzle-orm/pg-core";
import { id, oneOf, softDelete, tenantPolicy, textEnum, timestamps } from "@/platform/db/columns";
import { users } from "@/modules/auth/schema";
import { organizations } from "@/modules/tenancy/schema";

export const SITE_STATUSES = ["coming_soon", "live", "suspended"] as const;

/**
 * sites — class: tenant. UNIQUE (organization_id, id) is the target of every
 * site-scoped table's composite foreign key, which makes it impossible for a
 * row to claim a site that belongs to another organization (D-04 layer 2).
 */
export const sites = pgTable(
  "sites",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: textEnum("status", SITE_STATUSES).notNull().default("coming_soon"),
    themeKey: text("theme_key").notNull().default("studio"),
    defaultLocale: text("default_locale").notNull().default("en"),
    timezone: text("timezone").notNull().default("UTC"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    unique("sites_org_id_unique").on(t.organizationId, t.id),
    uniqueIndex("sites_org_slug_unique").on(t.organizationId, t.slug).where(sql`deleted_at is null`),
    oneOf("sites_status_check", t.status, SITE_STATUSES),
    check("sites_slug_format", sql`${sql.identifier("slug")} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    tenantPolicy("sites"),
  ],
).enableRLS();

/**
 * The composite foreign key every site-scoped table carries:
 * (organization_id, site_id) → sites(organization_id, id), cascading on delete.
 */
export const siteForeignKey = (table: string, t: { organizationId: PgColumn; siteId: PgColumn }) =>
  foreignKey({
    name: `${table}_site_fk`,
    columns: [t.organizationId, t.siteId],
    foreignColumns: [sites.organizationId, sites.id],
  }).onDelete("cascade");

/**
 * site_settings — 1:1 with the site. Reference columns (homepage, 404 page,
 * logo, favicon) get composite foreign keys with ON DELETE SET NULL (col) in a
 * hand-written migration (Drizzle cannot express the column list). JSONB
 * groups are validated by Zod in the sites module. Class: tenant.
 */
export const siteSettings = pgTable(
  "site_settings",
  {
    siteId: uuid("site_id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    homepageEntryId: uuid("homepage_entry_id"),
    notFoundEntryId: uuid("not_found_entry_id"),
    logoMediaId: uuid("logo_media_id"),
    faviconMediaId: uuid("favicon_media_id"),
    general: jsonb("general").$type<Record<string, unknown>>().notNull().default({}),
    reading: jsonb("reading").$type<Record<string, unknown>>().notNull().default({}),
    seo: jsonb("seo").$type<Record<string, unknown>>().notNull().default({}),
    analytics: jsonb("analytics").$type<Record<string, unknown>>().notNull().default({}),
    theme: jsonb("theme").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(1),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [siteForeignKey("site_settings", t), tenantPolicy("site_settings")],
).enableRLS();

