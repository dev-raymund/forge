import { defineConfig, devices } from "@playwright/test";
import { E2E_CRON_SECRET, E2E_GOOGLE_CLIENT_ID, E2E_GOOGLE_CLIENT_SECRET } from "./tests/e2e/helpers/env";

/**
 * E2E runs against a production build (`next build && next start`) by default,
 * as in the plan (§30), on one host like the V1 deployment (ADR 0006):
 *   localhost:3100/…              admin, API
 *   localhost:3100/s/{address}/…  tenant sites
 *
 * A second server on the next port runs the same build with Google sign-in
 * configured (placeholder credentials), for `google.spec.ts` only. The main
 * server has none, like local development and CI. The two share one database:
 * see the note in google.spec.ts about emails.
 *
 * E2E_SERVER=dev uses `next dev` for faster local iteration (one server).
 *
 * E2E_BASE_URL=https://<preview> runs the same specs against a deployment
 * (no local server); VERCEL_AUTOMATION_BYPASS_SECRET passes Vercel
 * deployment protection.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const GOOGLE_PORT = PORT + 1;
const useDev = process.env.E2E_SERVER === "dev";
const externalBaseUrl = process.env.E2E_BASE_URL;
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
// Two `next dev` processes cannot share one project directory.
const withGoogleServer = !externalBaseUrl && !useDev;
const GOOGLE_SPEC = /google\.spec\.ts$/;

function server(port: number, google: { GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string }) {
  return {
    command: useDev ? `npx next dev -p ${port}` : `npx next start -p ${port}`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      APP_ORIGIN: `http://localhost:${port}`,
      CRON_SECRET: E2E_CRON_SECRET,
      // Email goes to the local Mailpit inbox (docker-compose); never a real service.
      EMAIL_PROVIDER: "mailpit",
      // Files go to a local directory (gitignored); no storage account.
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: ".storage/e2e",
      ...google,
    },
  };
}

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...(bypass ? { extraHTTPHeaders: { "x-vercel-protection-bypass": bypass, "x-vercel-set-bypass-cookie": "true" } } : {}),
  },
  projects: [
    { name: "chromium", testIgnore: GOOGLE_SPEC, use: { ...devices["Desktop Chrome"] } },
    ...(withGoogleServer
      ? [{ name: "google", testMatch: GOOGLE_SPEC, use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${GOOGLE_PORT}` } }]
      : []),
  ],
  webServer: externalBaseUrl
    ? undefined
    : [
        // Empty values count as unset: no Google here, whatever .env.local says.
        server(PORT, { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }),
        ...(withGoogleServer ? [server(GOOGLE_PORT, { GOOGLE_CLIENT_ID: E2E_GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: E2E_GOOGLE_CLIENT_SECRET })] : []),
      ],
});
