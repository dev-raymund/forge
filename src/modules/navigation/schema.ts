import { integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, oneOf, siteColumns, tenantPolicy, textEnum, timestamps } from "@/platform/db/columns";
import { users } from "@/modules/auth/schema";
import { siteForeignKey } from "@/modules/sites/schema";

export const MENU_LOCATIONS = ["header", "footer"] as const;

/**
 * menus — one per location; items are a Zod-validated JSONB tree (depth ≤ 2,
 * ≤ 100 items) edited and saved as a whole (v1-build-plan §4.1). Entry links
 * store the entry id and resolve to the live path at render time.
 */
export const menus = pgTable(
  "menus",
  {
    id: id(),
    ...siteColumns(),
    location: textEnum("location", MENU_LOCATIONS).notNull(),
    name: text("name").notNull().default(""),
    items: jsonb("items").$type<unknown[]>().notNull().default([]),
    version: integer("version").notNull().default(1),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    siteForeignKey("menus", t),
    unique("menus_site_location_unique").on(t.siteId, t.location),
    oneOf("menus_location_check", t.location, MENU_LOCATIONS),
    tenantPolicy("menus"),
  ],
).enableRLS();
