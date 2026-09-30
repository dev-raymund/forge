import type { Config } from "drizzle-kit";

/**
 * drizzle-kit configuration (D-32).
 *
 * `generate` diffs the TypeScript schema against the last snapshot and writes
 * SQL into ./drizzle for review. Hand-written SQL (RLS FORCE, grants, SECURITY
 * DEFINER lookups, composite FKs with SET NULL (col), trigram indexes) goes in
 * custom migrations: `npm run db:generate:custom`.
 *
 * `push` is refused unless the target is a local database: every schema
 * change that can reach customer data is a reviewed migration.
 */
const url = process.env.DATABASE_MIGRATION_URL ?? "postgres://forge_owner:forge_owner@localhost:5432/forge";

if (process.argv.includes("push")) {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`drizzle-kit push is only allowed against a local database (got ${host}). Generate a migration instead.`);
  }
}

export default {
  schema: "./src/platform/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  // Role and policy objects referenced by policies are managed in migrations.
  entities: { roles: false },
  strict: true,
  verbose: true,
} satisfies Config;
