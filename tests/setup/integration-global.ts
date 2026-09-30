import pg from "pg";
import { runMigrations } from "../../scripts/db/migrate";
import { INTEGRATION_WORKERS, ownerUrl, TEMPLATE_DB, workerDbName } from "./db-urls";

/**
 * Runs once before the integration project:
 *  1. (re)creates a template database and applies every migration to it as
 *     forge_owner over a direct connection (like CI's DATABASE_MIGRATION_URL);
 *  2. clones one database per Vitest worker from the template, so workers never
 *     share state and each test file starts from the migrated schema.
 * Tests then connect as forge_app through PgBouncer (transaction mode), exactly
 * like production's pooled DATABASE_URL.
 */
export default async function setup() {
  const admin = new pg.Client({ connectionString: ownerUrl("forge"), connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Integration tests need Postgres + PgBouncer. Run \`npm run dev:services\` first.\n(${String(err)})`,
    );
  }
  try {
    const all = [TEMPLATE_DB, ...Array.from({ length: INTEGRATION_WORKERS }, (_, i) => workerDbName(i + 1))];
    for (const db of all) await admin.query(`drop database if exists "${db}" with (force)`);
    await admin.query(`create database "${TEMPLATE_DB}"`);
    await runMigrations(ownerUrl(TEMPLATE_DB));
    for (let i = 1; i <= INTEGRATION_WORKERS; i++) {
      await admin.query(`create database "${workerDbName(i)}" template "${TEMPLATE_DB}"`);
    }
  } finally {
    await admin.end();
  }
}
