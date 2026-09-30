import pg from "pg";

/**
 * Runs once before the integration project. Fails fast with an actionable
 * message when the docker-compose services are not running.
 */
export default async function setup() {
  const url =
    process.env.TEST_DATABASE_APP_URL ?? "postgres://forge_app:forge_app@localhost:6432/forge";
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("select 1");
  } catch (err) {
    throw new Error(
      `Integration tests need Postgres + PgBouncer. Run \`npm run dev:services\` first.\n(${String(err)})`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}
