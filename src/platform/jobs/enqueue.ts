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
 * must be enqueued inside `withTenant()`. Platform jobs have no organization.
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
  if (job.scope === "tenant") {
    const { rows } = await tx.execute<{ org: string | null }>(sql`select app_current_org_id() as org`);
    orgId = rows[0]?.org ?? null;
    if (!orgId) throw new Error(`Tenant job "${job.type}" must be enqueued inside withTenant()`);
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

/** For adapters without a business transaction (cron routes): a platform job in its own transaction. */
export async function enqueuePlatformJob<P>(
  job: JobDefinition<P>,
  payload: P,
  options?: EnqueueOptions,
): Promise<EnqueueResult> {
  if (job.scope !== "platform") throw new Error(`"${job.type}" is a tenant job; enqueue it inside withTenant()`);
  return withPlatform((tx) => enqueue(tx, job, payload, options));
}
