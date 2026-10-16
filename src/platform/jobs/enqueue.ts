import "server-only";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { withPlatform, type Tx } from "@/platform/db/tenant";
import { DEFAULT_MAX_ATTEMPTS, type JobDefinition } from "./definition";

export type EnqueueOptions = {
  /** Earliest start. Default: now. */
  runAt?: Date;
  /** Natural key: while a job with this key is queued or running, enqueueing it again is a no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
};

export type EnqueueResult = { id: string; deduplicated: boolean };

/**
 * Adds a job INSIDE the caller's transaction (plan §16): the job exists only
 * if the business change commits. The payload is validated first (ZodError on
 * failure; nothing is written).
 *
 * Tenant jobs take their organization from the transaction's RLS context
 * (`app_current_org_id()`), so the organization can't come from user input and
 * must be enqueued inside `withTenant()`. `inherit` jobs take it when the
 * transaction has one. Platform jobs have no organization.
 */
export async function enqueue<P>(
  tx: Tx,
  job: JobDefinition<P>,
  payload: P,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const data = job.payload.parse(payload);
  const maxAttempts = options.maxAttempts ?? job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");

  let orgId: string | null = null;
  if (job.scope !== "platform") {
    const { rows } = await tx.execute<{ org: string | null }>(sql`select app_current_org_id() as org`);
    orgId = rows[0]?.org ?? null;
    if (job.scope === "tenant" && !orgId) throw new Error(`Tenant job "${job.type}" must be enqueued inside withTenant()`);
  }

  const inserted = await tx.execute<{ id: string }>(sql`
    insert into jobs (id, type, organization_id, payload, run_at, max_attempts, dedupe_key)
    values (
      ${uuidv7()}, ${job.type}, ${orgId}, ${JSON.stringify(data)}::jsonb,
      coalesce(${options.runAt?.toISOString() ?? null}::timestamptz, now()), ${maxAttempts}, ${options.dedupeKey ?? null}
    )
    on conflict (dedupe_key) where dedupe_key is not null and status in ('queued', 'running') do nothing
    returning id`);
  const id = inserted.rows[0]?.id;
  if (id) return { id, deduplicated: false };

  const existing = await tx.execute<{ id: string }>(sql`
    select id from jobs where dedupe_key = ${options.dedupeKey ?? null} and status in ('queued', 'running')`);
  const existingId = existing.rows[0]?.id;
  if (!existingId) throw new Error(`Job "${job.type}" was neither inserted nor found (dedupe race)`);
  return { id: existingId, deduplicated: true };
}

/** For adapters without a business transaction (cron routes): a platform (or tenant-less `inherit`) job in its own transaction. */
export async function enqueuePlatformJob<P>(
  job: JobDefinition<P>,
  payload: P,
  options?: EnqueueOptions,
): Promise<EnqueueResult> {
  if (job.scope === "tenant") throw new Error(`"${job.type}" is a tenant job; enqueue it inside withTenant()`);
  return withPlatform((tx) => enqueue(tx, job, payload, options));
}

/**
 * A queued job, found by its natural key in the transaction's own organization (`app_current_org_id()`, never a
 * parameter: `jobs` has no RLS, so this is its only scope), moved to a new time and payload (M7-2: a schedule changed).
 * `running` when that job is being run right now (it cannot be moved under its runner); `none` when there is none.
 */
export async function moveQueuedJob<P>(tx: Tx, job: JobDefinition<P>, dedupeKey: string, payload: P, runAt: Date): Promise<"moved" | "running" | "none"> {
  const data = job.payload.parse(payload);
  const { rows } = await tx.execute<{ status: string }>(sql`
    with found as (
      select id, status from jobs
       where type = ${job.type} and dedupe_key = ${dedupeKey} and organization_id = app_current_org_id() and status in ('queued', 'running')
       for update
    ), moved as (
      update jobs set run_at = ${runAt.toISOString()}::timestamptz, payload = ${JSON.stringify(data)}::jsonb, attempts = 0, last_error = null, updated_at = now()
        from found where jobs.id = found.id and found.status = 'queued'
      returning jobs.id
    )
    select status from found`);
  const status = rows[0]?.status;
  return status === "queued" ? "moved" : status === "running" ? "running" : "none";
}

/** Cancels the queued job with this natural key in the transaction's own organization. Returns how many were canceled. */
export async function cancelQueuedJob(tx: Tx, job: JobDefinition<unknown>, dedupeKey: string): Promise<number> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    update jobs set status = 'canceled', finished_at = now(), updated_at = now()
     where type = ${job.type} and dedupe_key = ${dedupeKey} and organization_id = app_current_org_id() and status = 'queued'
    returning id`);
  return rows.length;
}
