import * as Sentry from "@sentry/nextjs";
import { SENTRY_DATA_COLLECTION, scrubEvent } from "./scrub";

/** Browser Sentry for the admin app only (see src/instrumentation-client.ts). */
export function initClientSentry() {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
    dataCollection: SENTRY_DATA_COLLECTION,
    tracesSampleRate: 0.1,
    beforeSend: (event) => scrubEvent(event),
    // Page-load transactions carry the URL: the reset page's query string holds a token.
    beforeSendTransaction: (event) => scrubEvent(event),
  });
}
