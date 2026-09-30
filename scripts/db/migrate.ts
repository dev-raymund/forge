/**
 * Apply pending migrations from ./drizzle as the schema owner (D-32).
 *
 *   npm run db:migrate            uses DATABASE_MIGRATION_URL (from .env.local locally)
 *
 * Always a DIRECT connection as forge_owner — never the pooled runtime URL.
 * In production this runs from CI before the new code deploys.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export async function runMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await migrate(drizzle({ client }), {
      migrationsFolder: path.resolve(import.meta.dirname, "../../drizzle"),
    });
  } finally {
    await client.end();
  }
}

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: rely on the environment (CI).
  }
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL is not set (direct connection as forge_owner).");
  await runMigrations(url);
  console.log("Migrations applied.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
