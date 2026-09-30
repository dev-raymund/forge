import { connection } from "next/server";
import { env } from "@/platform/config/env";
import { notFound, problemResponse } from "@/platform/errors";
import { reportError, requestIdFrom } from "@/platform/observability";
import { hasBearerSecret } from "@/platform/security/bearer";

/**
 * Sends one test error to Sentry (M1-2 acceptance: "a test error visible in
 * Sentry from preview"). Requires `Authorization: Bearer $CRON_SECRET`;
 * anything else is a 404.
 */
export async function POST(request: Request) {
  await connection();
  const requestId = requestIdFrom(request.headers);
  let secret = "";
  try {
    secret = env("cron").CRON_SECRET;
  } catch {
    // not configured: behave as if the route did not exist
  }
  if (!hasBearerSecret(request.headers, secret)) return problemResponse(notFound(), requestId);

  const eventId = reportError(new Error("Forge Sentry test error (M1-2)"), { requestId, module: "observability" });
  return Response.json({ ok: true, requestId, sentryEventId: eventId ?? null });
}
