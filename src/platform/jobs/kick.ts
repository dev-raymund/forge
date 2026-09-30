import "server-only";
import { after } from "next/server";
import { reportError } from "@/platform/observability/sentry";
import { createJobRegistry, type JobDefinition } from "./definition";
import { runJobs } from "./runner";

/**
 * Low-latency path (plan §16): after the response is sent, run the job types
 * the caller just enqueued, in this invocation. Best effort only: if it never
 * runs, the per-minute cron picks the jobs up. Only the given types are
 * claimed, so a light request never ends up running heavy jobs.
 *
 * Call from Server Actions and route handlers (adapters), never from services.
 */
export function kickJobs(definitions: readonly JobDefinition[], options: { budgetMs?: number } = {}) {
  after(async () => {
    try {
      await runJobs({ registry: createJobRegistry(definitions), budgetMs: options.budgetMs ?? 10_000 });
    } catch (err) {
      reportError(err, { module: "jobs" }, { phase: "kick" });
    }
  });
}
