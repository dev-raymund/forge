import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

/**
 * The database client (D-05). PRIVATE to platform/ — ESLint forbids importing
 * this file elsewhere. Everything else goes through withTenant()/withUser()/
 * withPlatform() in ./tenant, so every query runs inside a transaction whose
 * tenant context RLS can see.
 *
 * - `pg` Pool over Neon's POOLED endpoint (PgBouncer, transaction mode) as the
 *   runtime role `forge_app`, which owns nothing and cannot bypass RLS.
 * - attachDatabasePool() releases idle clients before a Fluid-compute instance
 *   suspends; it is a no-op outside Vercel.
 * - Created lazily on first use, never at import: a missing DATABASE_URL must
 *   fail the request that needs it, not every import (the Forgeline lesson).
 */
export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: Database | undefined;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Locally, copy .env.example to .env.local and run `npm run dev:services`.",
    );
  }
  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  attachDatabasePool(pool);
  return pool;
}

export function getDb(): Database {
  db ??= drizzle({ client: getPool(), schema });
  return db;
}

/** For tests and scripts that must release connections before exiting. */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  db = undefined;
  await current?.end();
}
