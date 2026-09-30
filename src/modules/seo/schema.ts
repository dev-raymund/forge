import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, oneOf, siteColumns, tenantPolicy, textEnum, timestamps } from "@/platform/db/columns";
import { users } from "@/modules/auth/schema";
import { siteForeignKey } from "@/modules/sites/schema";

export const REDIRECT_ORIGINS = ["manual", "auto"] as const;

/** Exact-match redirects (V1, D-20 simplified); auto-created on path changes. */
export const redirects = pgTable(
  "redirects",
  {
    id: id(),
    ...siteColumns(),
    sourcePath: text("source_path").notNull(),
    destination: text("destination").notNull(),
    statusCode: integer("status_code").notNull().default(301),
    origin: textEnum("origin", REDIRECT_ORIGINS).notNull().default("manual"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    siteForeignKey("redirects", t),
    unique("redirects_site_source_unique").on(t.siteId, t.sourcePath),
    check("redirects_status_code_check", sql`status_code in (301, 302, 307, 308)`),
    check("redirects_source_is_path", sql`source_path like '/%' and source_path not like '/\\_forge%'`),
    oneOf("redirects_origin_check", t.origin, REDIRECT_ORIGINS),
    tenantPolicy("redirects"),
  ],
).enableRLS();
