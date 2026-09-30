import { connection } from "next/server";
import { notFound, problemResponse } from "@/platform/errors";
import { enqueuePlatformJob, isCronRequest } from "@/platform/jobs";
import { requestIdFrom } from "@/platform/observability";
import { DAILY_JOBS } from "../jobs";

/**
 * Daily at 03:00 UTC (vercel.json): enqueues the maintenance jobs, which the
 * per-minute runner executes. The dated dedupe key collapses a double-fired
 * cron while the first job is still pending; after it has run, a repeat just
 * runs an idempotent job again.
 */
export async function GET(request: Request) {
  await connection();
  const requestId = requestIdFrom(request.headers);
  if (!isCronRequest(request.headers)) return problemResponse(notFound(), requestId);

  const day = new Date().toISOString().slice(0, 10);
  const enqueued = [];
  for (const job of DAILY_JOBS) {
    const result = await enqueuePlatformJob(job, {}, { dedupeKey: `${job.type}:${day}` });
    enqueued.push({ type: job.type, ...result });
  }
  return Response.json({ ok: true, requestId, enqueued }, { headers: { "cache-control": "no-store" } });
}
