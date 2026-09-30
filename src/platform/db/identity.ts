import "server-only";
import { getDb, type Database } from "./client";

/**
 * Database handle for Better Auth's Drizzle adapter (ADR 0004).
 *
 * Better Auth issues its own queries against the identity tables (`users`,
 * `auth_*`), so it needs a database handle rather than a `withTenant()`
 * callback. Identity tables have no RLS by design (class `identity`), and this
 * handle carries no tenant context, so every tenant table stays invisible
 * through it. Lint allows only `modules/auth` to import this file.
 */
export function identityDb(): Database {
  return getDb();
}
