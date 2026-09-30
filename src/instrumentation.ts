import * as Sentry from "@sentry/nextjs";

/** Server start-up hook (Next.js instrumentation). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initServerSentry } = await import("./platform/observability/sentry");
    initServerSentry();
  }
}

/** Errors thrown while rendering or in route handlers reach Sentry with the request's route. */
export const onRequestError = Sentry.captureRequestError;
