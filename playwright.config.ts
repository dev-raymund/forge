import { defineConfig, devices } from "@playwright/test";
import { E2E_CRON_SECRET } from "./tests/e2e/helpers/env";

/**
 * E2E runs against a production build (`next build && next start`) by default,
 * as in the plan (§30), on one host like the V1 deployment (ADR 0006):
 *   localhost:3100/…              admin, API
 *   localhost:3100/s/{address}/…  tenant sites
 *
 * E2E_SERVER=dev uses `next dev` for faster local iteration.
 *
 * E2E_BASE_URL=https://<preview> runs the same specs against a deployment
 * (no local server); VERCEL_AUTOMATION_BYPASS_SECRET passes Vercel
 * deployment protection.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const useDev = process.env.E2E_SERVER === "dev";
const externalBaseUrl = process.env.E2E_BASE_URL;
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: externalBaseUrl ? undefined : {
    command: useDev ? `npx next dev -p ${PORT}` : `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      APP_ORIGIN: `http://localhost:${PORT}`,
      CRON_SECRET: E2E_CRON_SECRET,
      // Email goes to the local Mailpit inbox (docker-compose); never a real service.
      EMAIL_PROVIDER: "mailpit",
    },
  },
});
