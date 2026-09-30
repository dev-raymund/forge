/**
 * Browser start-up hook. Sentry runs in the admin app only: public tenant
 * sites ship no admin or monitoring JS (D-37), so the SDK is a lazily loaded
 * chunk requested only when the admin root layout marks the document.
 */
if (document.documentElement.dataset.surface === "admin" && process.env.NEXT_PUBLIC_SENTRY_DSN) {
  void import("./platform/observability/sentry-client").then((m) => m.initClientSentry());
}
