/**
 * Integration-test database URLs.
 *
 * Defaults target docker-compose. Override the base URLs to run the suite
 * against Neon (see docs/runbooks/environments.md §1b):
 *   TEST_DATABASE_OWNER_URL  direct connection as forge_owner (migrations, DB cloning)
 *   TEST_DATABASE_APP_URL    POOLED connection as forge_app (what the app uses)
 */
export const INTEGRATION_WORKERS = 4;
export const TEMPLATE_DB = "forge_test_template";

const OWNER_BASE = process.env.TEST_DATABASE_OWNER_URL ?? "postgres://forge_owner:forge_owner@localhost:5432/forge";
const APP_BASE = process.env.TEST_DATABASE_APP_URL ?? "postgres://forge_app:forge_app@localhost:6432/forge";

export const workerDbName = (poolId: number) => `forge_test_w${poolId}`;

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

export const ownerUrl = (database: string) => withDatabase(OWNER_BASE, database);
export const appUrl = (database: string) => withDatabase(APP_BASE, database);
/** Direct (unpooled) connection as forge_app — used only to demonstrate pooler behaviour. */
export const appDirectUrl = (database: string) => {
  const url = new URL(withDatabase(OWNER_BASE, database));
  const app = new URL(APP_BASE);
  url.username = app.username;
  url.password = app.password;
  return url.toString();
};
