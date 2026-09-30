import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against a production build (`next build && next start`) by default,
 * as in the plan (§30). Hosts use `*.localhost`, which browsers resolve to
 * loopback, so tenant routing is exercised without editing /etc/hosts:
 *   app.localhost:3100            admin
 *   <sub>.sites.localhost:3100    tenant sites
 *
 * E2E_SERVER=dev uses `next dev` for faster local iteration.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const useDev = process.env.E2E_SERVER === "dev";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://app.localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: useDev ? `npx next dev -p ${PORT}` : `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...process.env, APP_ORIGIN: `http://app.localhost:${PORT}`, SITES_ROOT_DOMAIN: "sites.localhost" },
  },
});
