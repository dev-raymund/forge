import "server-only";
import { sql } from "drizzle-orm";
import { withPlatform, withTenant } from "@/platform/db/tenant";
import { logger, redact, withLogContext } from "@/platform/observability/logger";
import { reportError } from "@/platform/observability/sentry";
import {
  backoffSeconds,
  DEFAULT_LOCK_SECONDS,
  PermanentJobError,
  type JobContext,
  type JobDefinition,
  type JobRegistry,
} from "./definition";

/**
 * The job runner (plan §16, ADR 0005). One invocation:
 *  1. reaps expired claims (crashed runners),
 *  2. claims one due job at a time (`FOR UPDATE SKIP LOCKED`), runs it, records
 *     the outcome — until the queue is empty or 75% of the budget is spent.
 *
 * Every step is its own short transaction on the pooled connection. Nothing
 * is held open while a handler runs. The outcome is written only if the job
 * is still this runner's claim (`attempts` is the fencing token), so a runner
 * that lost its claim can never overwrite a newer result.
 */

export type RunOptions = {
  registry: JobRegistry;
  /** The invocation's wall-clock budget; claiming stops at 75% of it. */
  budgetMs: number;
  /** Stop after this many jobs (tests, kicks). */
  maxJobs?: number;
  /** Fake clock for tests. Default: the database's `now()`. */
  now?: () => Date;
  /** Jitter source for tests. */
  random?: () => number;
};

export type RunSummary = {
  reaped: { requeued: number; dead: number };
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
  failed: number;
  lostClaim: number;
  stoppedBy: "empty" | "budget" | "maxJobs";
};

export type ClaimedJob = {
  id: string;
  type: string;
  organization_id: string | null;
  payload: unknown;
  attempts: number;
  max_attempts: number;
};

type Outcome =
  | { status: "succeeded" }
  | { status: "queued"; delaySeconds: number; error: string }
  | { status: "dead" | "failed"; error: string; cause: unknown };

const BUDGET_FRACTION = 0.75;
const at = (now?: () => Date) => (now ? now().toISOString() : null);

function errorText(err: unknown): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return String(redact(message)).slice(0, 2_000);
}

/** Claims past `locked_until` go back to the queue (or to `dead` when attempts are used up). */
export async function reapExpiredClaims(now?: () => Date): Promise<{ requeued: number; dead: number }> {
  const t = at(now);
  const { rows } = await withPlatform((tx) =>
    tx.execute<{ status: string }>(sql`
      update jobs set
        status = case when attempts >= max_attempts then 'dead' else 'queued' end,
        run_at = case when attempts >= max_attempts then run_at else coalesce(${t}::timestamptz, now()) end,
        finished_at = case when attempts >= max_attempts then coalesce(${t}::timestamptz, now()) else null end,
        locked_until = null,
        last_error = 'Claim expired: the runner crashed or ran out of time',
        updated_at = now()
      where status = 'running' and locked_until < coalesce(${t}::timestamptz, now())
      returning status`),
  );
  return {
    requeued: rows.filter((r) => r.status === "queued").length,
    dead: rows.filter((r) => r.status === "dead").length,
  };
}

/** Atomically moves the next due job of a registered type to `running`. Concurrent callers never get the same job. */
export async function claimNext(registry: JobRegistry, now?: () => Date): Promise<ClaimedJob | null> {
  if (!registry.types.length) return null;
  const t = at(now);
  const locks = Object.fromEntries(registry.types.map((type) => [type, registry.get(type)?.lockSeconds ?? DEFAULT_LOCK_SECONDS]));
  const { rows } = await withPlatform((tx) =>
    tx.execute<ClaimedJob>(sql`
      update jobs set
        status = 'running',
        attempts = attempts + 1,
        locked_until = coalesce(${t}::timestamptz, now())
          + make_interval(secs => coalesce((${JSON.stringify(locks)}::jsonb ->> type)::int, ${DEFAULT_LOCK_SECONDS})),
        updated_at = now()
      where id = (
        select id from jobs
        where status = 'queued'
          and run_at <= coalesce(${t}::timestamptz, now())
          and type in (select jsonb_array_elements_text(${JSON.stringify(registry.types)}::jsonb))
        order by run_at, id
        limit 1
        for update skip locked
      )
      returning id, type, organization_id, payload, attempts, max_attempts`),
  );
  return rows[0] ?? null;
}

async function execute(job: ClaimedJob, definition: JobDefinition, options: RunOptions): Promise<Outcome> {
  const parsed = definition.payload.safeParse(job.payload);
  if (!parsed.success) {
    return { status: "failed", error: `Invalid payload: ${errorText(parsed.error)}`, cause: parsed.error };
  }
  const orgId = job.organization_id;
  if (definition.scope === "tenant" && !orgId) {
    const cause = new PermanentJobError("Tenant job has no organization");
    return { status: "failed", error: errorText(cause), cause };
  }

  const ctx: JobContext = {
    job: { id: job.id, type: job.type, attempt: job.attempts, maxAttempts: job.max_attempts },
    orgId,
    withTenant: (work) => {
      if (!orgId) throw new PermanentJobError(`"${job.type}" is a platform job and has no tenant`);
      return withTenant({ orgId }, work);
    },
    log: logger.child({ module: "jobs", ...(orgId ? { orgId } : {}) }),
  };

  try {
    await definition.run(parsed.data, ctx);
    return { status: "succeeded" };
  } catch (err) {
    if (err instanceof PermanentJobError) return { status: "failed", error: errorText(err), cause: err };
    if (job.attempts >= job.max_attempts) return { status: "dead", error: errorText(err), cause: err };
    const delaySeconds = backoffSeconds(job.attempts, definition.backoff, options.random);
    return { status: "queued", delaySeconds, error: errorText(err) };
  }
}

/** Writes the outcome if the job is still this claim. Returns false when the claim was lost. */
async function record(job: ClaimedJob, outcome: Outcome, now?: () => Date): Promise<boolean> {
  const t = at(now);
  const { rows } = await withPlatform((tx) => {
    const fence = sql`id = ${job.id} and status = 'running' and attempts = ${job.attempts}`;
    switch (outcome.status) {
      case "succeeded":
        return tx.execute(sql`
          update jobs set status = 'succeeded', finished_at = coalesce(${t}::timestamptz, now()),
            locked_until = null, last_error = null, updated_at = now()
          where ${fence} returning id`);
      case "queued":
        return tx.execute(sql`
          update jobs set status = 'queued', locked_until = null, last_error = ${outcome.error},
            run_at = coalesce(${t}::timestamptz, now()) + make_interval(secs => ${outcome.delaySeconds}),
            updated_at = now()
          where ${fence} returning id`);
      default:
        return tx.execute(sql`
          update jobs set status = ${outcome.status}, finished_at = coalesce(${t}::timestamptz, now()),
            locked_until = null, last_error = ${outcome.error}, updated_at = now()
          where ${fence} returning id`);
    }
  });
  return rows.length === 1;
}

export async function runJobs(options: RunOptions): Promise<RunSummary> {
  const deadline = performance.now() + options.budgetMs * BUDGET_FRACTION;
  const summary: RunSummary = {
    reaped: await reapExpiredClaims(options.now),
    claimed: 0,
    succeeded: 0,
    retried: 0,
    dead: 0,
    failed: 0,
    lostClaim: 0,
    stoppedBy: "empty",
  };

  for (;;) {
    if (performance.now() >= deadline) {
      summary.stoppedBy = "budget";
      break;
    }
    if (options.maxJobs !== undefined && summary.claimed >= options.maxJobs) {
      summary.stoppedBy = "maxJobs";
      break;
    }
    const job = await claimNext(options.registry, options.now);
    if (!job) break;
    summary.claimed++;

    const definition = options.registry.get(job.type)!; // only registered types are claimed
    const logContext = { module: "jobs", actor: "system", ...(job.organization_id ? { orgId: job.organization_id } : {}) };
    const fields = { jobId: job.id, jobType: job.type, attempt: job.attempts };
    const started = performance.now();
    const outcome = await withLogContext(logContext, () => execute(job, definition, options));
    const recorded = await record(job, outcome, options.now);
    const durationMs = Math.round(performance.now() - started);

    await withLogContext(logContext, async () => {
      if (!recorded) {
        summary.lostClaim++;
        logger.warn("job finished after losing its claim; outcome discarded", { ...fields, outcome: outcome.status, durationMs });
        return;
      }
      switch (outcome.status) {
        case "succeeded":
          summary.succeeded++;
          logger.info("job succeeded", { ...fields, durationMs });
          break;
        case "queued":
          summary.retried++;
          logger.warn("job failed; will retry", { ...fields, durationMs, retryInSeconds: outcome.delaySeconds, error: outcome.error });
          break;
        default:
          summary[outcome.status]++;
          reportError(outcome.cause, {}, { ...fields, status: outcome.status });
      }
    });
  }

  if (summary.claimed || summary.reaped.requeued || summary.reaped.dead) logger.info("job runner finished", { module: "jobs", ...summary });
  return summary;
}
