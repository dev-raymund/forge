/** Secrets the E2E server is started with (playwright.config.ts). Test-only values. */
export const E2E_CRON_SECRET = process.env.CRON_SECRET ?? "e2e-cron-secret-not-for-production";
