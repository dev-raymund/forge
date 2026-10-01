import { connection } from "next/server";
import { notFound, problemResponse } from "@/platform/errors";
import { isCronRequest, runJobs } from "@/platform/jobs";
import { requestIdFrom, withLogContext } from "@/platform/observability";
import { jobRegistry } from "./jobs";

/**
 * The job runner. Callers: an optional external scheduler every minute on the
 * free V1 deployment, or a per-minute Vercel cron on a paid plan (ADR 0006).
 * The daily cron and `kickJobs()` cover the rest.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  await connection();
  const requestId = requestIdFrom(request.headers);
  if (!isCronRequest(request.headers)) return problemResponse(notFound(), requestId);

  const summary = await withLogContext({ requestId, module: "jobs" }, () =>
    runJobs({ registry: jobRegistry, budgetMs: maxDuration * 1_000 }),
  );
  return Response.json({ ok: true, requestId, ...summary }, { headers: { "cache-control": "no-store" } });
}
