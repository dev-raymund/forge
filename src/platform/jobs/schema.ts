import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, oneOf, textEnum, timestamps } from "@/platform/db/columns";

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "dead", "canceled"] as const;

/**
 * jobs — class: platform (no RLS). The runner sweeps across tenants. A
 * tenant-scoped job records its organization in `organization_id` (taken from
 * the enqueuing transaction's RLS context, never from the payload) and its
 * handler runs inside withTenant() for that organization (ADR 0005).
 * Scheduled publishing is a job with run_at (no scheduled_actions table, §4.1).
 *
 * Statuses: queued → running → succeeded | queued (retry) | dead (attempts
 * exhausted) | failed (permanent error, not retried) | canceled (by staff).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type").notNull(),
    organizationId: uuid("organization_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: textEnum("status", JOB_STATUSES).notNull().default("queued"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    oneOf("jobs_status_check", t.status, JOB_STATUSES),
    index("jobs_queued_run_at_idx").on(t.runAt).where(sql`status = 'queued'`),
    // The reaper looks for expired locks every minute.
    index("jobs_running_locked_until_idx").on(t.lockedUntil).where(sql`status = 'running'`),
    uniqueIndex("jobs_active_dedupe_unique")
      .on(t.dedupeKey)
      .where(sql`dedupe_key is not null and status in ('queued', 'running')`),
  ],
);
