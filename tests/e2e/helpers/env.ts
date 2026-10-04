/** Secrets the E2E server is started with (playwright.config.ts). Test-only values. */
export const E2E_CRON_SECRET = process.env.CRON_SECRET ?? "e2e-cron-secret-not-for-production";

/**
 * A second server runs the same build with Google sign-in configured, so the
 * "configured" side of the UI can be tested. These are placeholders, not
 * credentials: Google is never contacted (the spec intercepts the navigation).
 */
export const E2E_GOOGLE_CLIENT_ID = "e2e-placeholder.apps.googleusercontent.com";
export const E2E_GOOGLE_CLIENT_SECRET = "e2e-placeholder-secret-not-a-credential";

/** The main E2E server (no Google). google.spec.ts creates its accounts there: see that file. */
export const E2E_MAIN_ORIGIN = process.env.E2E_BASE_URL ?? `http://localhost:${Number(process.env.E2E_PORT ?? 3100)}`;
