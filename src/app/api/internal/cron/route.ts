import { connection } from "next/server";
import { notFound, problemResponse } from "@/platform/errors";
import { isCronRequest, runJobs } from "@/platform/jobs";
import { requestIdFrom, withLogContext } from "@/platform/observability";
import { jobRegistry } from "./jobs";

/** The job runner, called by Vercel Cron every minute (vercel.json). */
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
