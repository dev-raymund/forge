import { sql, type SQL } from "drizzle-orm";
import { check, pgPolicy, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

/**
 * Column and policy helpers shared by every module's schema (v1-build-plan §4.2).
 * Conventions: UUIDv7 ids generated in the app (D-06), timestamptz everywhere,
 * enumerations as text + CHECK (no pg enum types), snake_case columns.
 */

/** UUIDv7 primary key, generated in the application. */
export const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const softDelete = () => ({
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/** `organization_id` — the tenant key on every tenant-owned row (D-03). */
export const orgColumns = () => ({
  organizationId: uuid("organization_id").notNull(),
});

/** `organization_id` + `site_id` for site-scoped rows. */
export const siteColumns = () => ({
  organizationId: uuid("organization_id").notNull(),
  siteId: uuid("site_id").notNull(),
});

/**
 * A text column typed to `values`. Drizzle's `enum` option types the column
 * only; pair it with {@link oneOf} in the table's extra config for the CHECK.
 */
export const textEnum = <const V extends readonly [string, ...string[]]>(name: string, values: V) =>
  text(name, { enum: values as unknown as [V[number], ...V[number][]] });

/** CHECK (column IN (...values)). */
export const oneOf = (constraintName: string, column: SQL | { name: string }, values: readonly string[]) => {
  const col = "name" in column ? sql.identifier(column.name) : column;
  // DDL cannot take bind parameters, so the (code-constant) values are inlined
  // as quoted literals.
  const list = sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", "));
  return check(constraintName, sql`${col} in (${list})`);
};

/**
 * RLS policy for a tenant table: rows are visible and writable only when their
 * organization_id equals the transaction's tenant context. The context helper
 * returns NULL when unset, so no context means no rows (fail closed).
 * FORCE ROW LEVEL SECURITY and grants are applied in hand-written migrations.
 */
export const tenantPolicy = (table: string) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: "permissive",
    for: "all",
    to: "public",
    using: sql`organization_id = app_current_org_id()`,
    withCheck: sql`organization_id = app_current_org_id()`,
  });
