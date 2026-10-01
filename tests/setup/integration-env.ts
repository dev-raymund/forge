import { afterAll } from "vitest";
import { appDirectUrl, appUrl, INTEGRATION_WORKERS, ownerUrl, workerDbName } from "./db-urls";

/**
 * Per-worker environment: each Vitest worker gets its own database cloned from
 * the migrated template (integration-global.ts). The application code under
 * test reads DATABASE_URL — pointed at the POOLED endpoint as forge_app.
 */
const poolId = Number(process.env.VITEST_POOL_ID ?? "1");
if (poolId < 1 || poolId > INTEGRATION_WORKERS) {
  throw new Error(`VITEST_POOL_ID ${poolId} exceeds the ${INTEGRATION_WORKERS} prepared worker databases.`);
}
const database = workerDbName(poolId);

process.env.DATABASE_URL = appUrl(database);
// The one app origin (ADR 0006): email links must point here.
process.env.APP_ORIGIN = "http://localhost:3000";
// Nothing may leave the machine in tests; suites that inspect email install a capture provider.
process.env.EMAIL_PROVIDER = "console";
process.env.TEST_WORKER_DATABASE = database;
process.env.TEST_WORKER_OWNER_URL = ownerUrl(database);
process.env.TEST_WORKER_APP_DIRECT_URL = appDirectUrl(database);

afterAll(async () => {
  const { closeDb } = await import("@/platform/db/client");
  await closeDb();
});
