import { uuidv7 } from "uuidv7";

/**
 * Request IDs (long-term D-33). `proxy.ts` (M1-7) assigns one per request and
 * forwards it as `x-request-id`; handlers read it back. It flows into logs,
 * Sentry tags, `audit_logs.request_id`, job payloads and `problem+json.instance`.
 */

export const REQUEST_ID_HEADER = "x-request-id";

// Printable and bounded: the value lands in logs and response headers.
const SAFE = /^[A-Za-z0-9:._-]{8,128}$/;

/**
 * For the proxy: reuse Vercel's id when present (it links to Vercel's logs),
 * otherwise mint a UUIDv7. A client-supplied `x-request-id` is ignored.
 */
export function assignRequestId(headers: Headers): string {
  const vercel = headers.get("x-vercel-id");
  return vercel && SAFE.test(vercel) ? vercel : uuidv7();
}

/** For handlers behind the proxy: the id the proxy assigned (or a fresh one if absent). */
export function requestIdFrom(headers: Headers): string {
  const id = headers.get(REQUEST_ID_HEADER);
  return id && SAFE.test(id) ? id : assignRequestId(headers);
}
