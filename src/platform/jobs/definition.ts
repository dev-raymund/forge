import type { z } from "zod";
import type { Logger } from "@/platform/observability/logger";
import type { TenantTx } from "@/platform/db/tenant";

/**
 * Job definitions (ADR 0005). A module declares each job type once, with a
 * Zod payload schema and an idempotent handler, and exports it. Enqueuers pass
 * the definition itself (typed payloads); the cron routes compose every
 * module's definitions into the runner's registry.
 */

export type JobScope = "tenant" | "platform";

export type JobContext = {
  job: { id: string; type: string; attempt: number; maxAttempts: number };
  /** The job's organization (tenant jobs), from the enqueuing transaction. Null for platform jobs. */
  orgId: string | null;
  /**
   * A tenant transaction for THIS job's organization only (RLS enforced).
   * Throws for platform jobs. Keep network calls outside it.
   */
  withTenant: <T>(work: (tx: TenantTx) => Promise<T>) => Promise<T>;
  log: Logger;
};

export type JobDefinition<P = unknown> = {
  type: string;
  scope: JobScope;
  payload: z.ZodType<P>;
  /** Default 5; can be overridden per enqueue. */
  maxAttempts?: number;
  /**
   * How long a claim lasts before the reaper may hand the job to another runner.
   * Default 900 s: longer than any Vercel function may run (800 s), so a live
   * runner never loses its claim; only crashed runners' jobs are reclaimed.
   */
  lockSeconds?: number;
  /** Exponential backoff with jitter between attempts. Default 30 s doubling, capped at 1 h. */
  backoff?: { baseSeconds: number; maxSeconds: number };
  /**
   * Must be idempotent: delivery is at least once (a runner can lose its lock
   * mid-run, or crash after the work but before recording success).
   */
  // Method syntax on purpose: definitions with specific payloads must fit the
  // registry's `JobDefinition<unknown>`; the runner re-validates every payload.
  run(payload: P, ctx: JobContext): Promise<void>;
};

export function defineJob<P>(definition: JobDefinition<P>): JobDefinition<P> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/.test(definition.type)) {
    throw new Error(`Job type "${definition.type}" must look like "module.action"`);
  }
  return definition;
}

/** Thrown by a handler for errors that retrying cannot fix. The job becomes `failed`. */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_LOCK_SECONDS = 900;
export const DEFAULT_BACKOFF = { baseSeconds: 30, maxSeconds: 3_600 };

export type JobRegistry = {
  get: (type: string) => JobDefinition | undefined;
  types: string[];
};

export function createJobRegistry(definitions: readonly JobDefinition[]): JobRegistry {
  const map = new Map<string, JobDefinition>();
  for (const definition of definitions) {
    if (map.has(definition.type)) throw new Error(`Job type "${definition.type}" is registered twice`);
    map.set(definition.type, definition);
  }
  return { get: (type) => map.get(type), types: [...map.keys()] };
}

/**
 * Delay before the next attempt: exponential (base × 2^(attempt−1), capped),
 * then "equal jitter" — half fixed, half random — so retries spread out but
 * never collapse to zero.
 */
export function backoffSeconds(attempt: number, backoff = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const exponential = Math.min(backoff.maxSeconds, backoff.baseSeconds * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}
