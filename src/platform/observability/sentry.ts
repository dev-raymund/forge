import "server-only";
import * as Sentry from "@sentry/nextjs";
import { currentLogContext, logger, redact, type LogContext } from "./logger";
import { SENTRY_DATA_COLLECTION, scrubEvent } from "./scrub";

/**
 * Server-side Sentry (long-term D-33): release = commit SHA, tenant IDs as
 * tags, PII scrubbed, no request bodies. Without a DSN (local dev, CI) the SDK
 * stays disabled and `reportError` still logs.
 */

export function initServerSentry() {
  const dsn = process.env.SENTRY_DSN || undefined;
  Sentry.init({
    dsn,
    enabled: !!dsn,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    dataCollection: SENTRY_DATA_COLLECTION,
    tracesSampleRate: 0.1,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  });
}

/** Tags that identify the tenant and request, IDs only. */
export function sentryTags(context: LogContext): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const key of ["requestId", "orgId", "siteId", "module"] as const) {
    if (context[key]) tags[key] = context[key]!;
  }
  return tags;
}

/**
 * For unexpected errors: one log line and one Sentry event, both carrying the
 * request and tenant context. Returns the Sentry event id (if sent).
 */
export function reportError(err: unknown, context: LogContext = {}, extra: Record<string, unknown> = {}): string | undefined {
  const merged = { ...currentLogContext(), ...context };
  logger.error("unexpected error", { ...merged, ...extra, err });
  return Sentry.withScope((scope) => {
    scope.setTags(sentryTags(merged));
    if (Object.keys(extra).length) scope.setContext("extra", redact(extra) as Record<string, unknown>);
    return Sentry.captureException(err);
  });
}
