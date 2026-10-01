import { connection } from "next/server";
import { notFound, problemResponse } from "@/platform/errors";
import { enqueuePlatformJob, isCronRequest, runJobs } from "@/platform/jobs";
import { requestIdFrom, withLogContext } from "@/platform/observability";
import { DAILY_JOBS, jobRegistry } from "../jobs";

/**
 * Daily (vercel.json, 03:00 UTC; on Vercel Hobby anywhere in 03:00–03:59):
 * enqueues the maintenance jobs, then runs the job runner, because on Hobby
 * this is the only Vercel cron (ADR 0006). Per-minute running comes from
 * `kickJobs()` after enqueues, an optional external scheduler calling
 * /api/internal/cron, or a per-minute Vercel cron on a paid plan.
 *
 * The dated dedupe key collapses a double-fired cron while the first job is
 * still pending; after it has run, a repeat just runs an idempotent job again.
 */
export const maxDuration = 60;

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
  const run = await withLogContext({ requestId, module: "jobs" }, () =>
    runJobs({ registry: jobRegistry, budgetMs: maxDuration * 1_000 }),
  );
  return Response.json({ ok: true, requestId, enqueued, run }, { headers: { "cache-control": "no-store" } });
}
