# ADR 0005: Postgres job queue — claiming, fencing, tenant scope

| | |
|---|---|
| **Status** | Accepted for V1. Proven locally against Postgres through PgBouncer (transaction mode); the Neon run follows ADR 0001's pending confirmation |
| **Date** | 2026-10-01 |
| **Issue** | M1-3 (v1-github-issues.md) |
| **Decisions touched** | D-22 as simplified in v1-build-plan §16 (clarified, not changed) |

## Context

v1-build-plan §16 fixes the mechanism:
- a `jobs` table;
- enqueue inside the business transaction;
- a runner at `/api/internal/cron` called by Vercel Cron every minute and kicked via `after()`;
- claims with `FOR UPDATE SKIP LOCKED`, exponential backoff, `dead` after `max_attempts`.

This ADR records the details the implementation had to settle. No Redis or external queue is used.

## Decisions

1. **Definitions live with their module; the app composes the registry.**
   - A job is `defineJob({ type, scope, payload: zod, run, maxAttempts?, lockSeconds?, backoff? })`, exported from the owning module.
   - Enqueuers pass the definition itself (`enqueue(tx, emailSend, payload)`), which gives typed payloads and needs no global registry.
   - `src/app/api/internal/cron/jobs.ts` is the composition root the runner uses. `platform/` never imports modules.
2. **Tenant jobs take their organization from the enqueuing transaction.**
   - `enqueue` reads `app_current_org_id()` inside the caller's `withTenant()` transaction and stores it in `jobs.organization_id`. It never comes from the payload or user input.
   - A tenant job enqueued outside a tenant transaction is an error.
   - The handler gets `ctx.withTenant(fn)`, bound to that organization only. A job for organization A holding B's ids reads and writes nothing of B's; RLS enforces it (tested).
   - Platform jobs have no organization, and `ctx.withTenant` throws.
3. **One job per claim, one short transaction per step.**
   - The runner reaps expired claims, then claims one due job at a time (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`), runs it, and records the outcome.
   - No transaction is open while a handler runs. Handlers open their own short tenant transactions and keep network calls outside them.
4. **`attempts` is the fencing token.**
   - The claim increments it, and the outcome is written only `WHERE status = 'running' AND attempts = <claimed attempt>`.
   - A runner that lost its claim cannot flip a newer outcome back. Its result is discarded and logged (`lostClaim`).
   - Delivery is therefore **at least once**, and handlers must be idempotent. `email.send` will use the job id as Resend's idempotency key (M1-4).
5. **A claim outlives any live runner: 900 s by default.**
   - Vercel functions run for at most 800 s on Pro and 300 s on Hobby, so the reaper only ever reclaims jobs from runners that crashed or were killed. A running handler is never handed to a second runner.
   - The cost is that a crashed job waits up to 15 minutes. Per-type `lockSeconds` can shorten this for jobs known to be quick.
6. **Statuses.** `queued → running →` one of:
   - `succeeded`
   - back to `queued` (retry, `run_at` pushed by the backoff)
   - `dead` (attempts exhausted, including a crash on the last attempt)
   - `failed` (a permanent error: `PermanentJobError`, a stored payload that no longer validates, or a tenant job without an organization; never retried)
   - `canceled` (staff action, M12).

   `dead` and `failed` report to Sentry.
7. **Backoff:** `base × 2^(attempt−1)`, capped, with "equal jitter" (half fixed, half random). The default is 30 s base, capped at 1 h: about 15–30 s, 30–60 s, 1–2 min, 2–4 min, then `dead` at 5 attempts. Types override `backoff` and `maxAttempts`.
8. **Time budget.** The cron route sets `maxDuration = 60` and stops claiming at 75% of it (45 s). Unknown job types (e.g. enqueued by a newer deployment during a rollout) are never claimed.
9. **Kicking via `after()`.**
   - `kickJobs([definitions])` runs *only the given types* in-process after the response, with a 10 s budget. A light request never ends up running heavy jobs (later `media.process`).
   - It is best effort. The minute cron is the delivery guarantee.
   - It is called from adapters (actions, route handlers), never from services, which don't import `next/*`.
10. **Clocks.** Production uses the database's `now()` everywhere. The runner accepts an injected clock for tests (`coalesce($now, now())`).
11. **Retention.** `jobs.cleanup` (daily, platform) deletes finished jobs after 14 days and `dead`/`failed` jobs after 30 days (long-term §6.9), in batches of 5,000. It is enqueued by `/api/internal/cron/daily` with a dated dedupe key.
12. **Dedupe.** While a job with the same `dedupe_key` is `queued` or `running`, `enqueue` returns the existing id (`deduplicated: true`) and writes nothing. After it finishes, the key is free again, so handlers must read current state when they run.
13. **Reaper index.** `jobs_running_locked_until_idx` (partial, `status = 'running'`) is added in migration 0003, because the reaper runs every minute.

## Additions in M1-4 (ADR 0007)

- **Scope `inherit`:** the job takes the enqueuing transaction's organization when it has one, otherwise none. The organization still never comes from the payload; `ctx.withTenant` fails permanently without one. Used by `email.send`.
- **`redactOnFinish(payload)`:** an optional definition hook. When a job finishes (succeeded, dead or failed), its return value replaces the stored payload in the same fenced update, so one-time links don't linger in the table. Retries keep the original.
- **`kickJobs()` outside a request** (scripts, tests, Better Auth hooks called directly) is a no-op instead of throwing. The cron runner delivers.

## Triggers on the free V1 deployment (ADR 0006)

Vercel Hobby allows only daily crons, and a per-minute schedule fails deployment. So:
- `vercel.json` has one cron, `/api/internal/cron/daily`, which enqueues the maintenance jobs and runs the runner.
- `kickJobs()` covers the jobs a request just enqueued.
- An optional free external scheduler calls `/api/internal/cron` for minute-level work.

The queue itself is unchanged.

## Evidence

`tests/integration/jobs.test.ts`: 24 tests against Postgres through PgBouncer as `forge_app`, stable over repeated runs.
- **Enqueue:** a job is added inside the caller's transaction; an invalid payload writes nothing; dedupe works.
- **Runner outcomes:** success; retry with backoff (fake clock); dead after max attempts; permanent failure; a stored payload that no longer validates; unknown types left alone; the 75% budget stop.
- **Concurrency:** 20 concurrent claimers over 8 jobs → 8 distinct claims; 4 parallel runners over 40 jobs → each processed exactly once.
- **Recovery and duplicates:** a crashed claim is reaped and rerun; a stale runner's late failure is discarded (fenced).
- **Tenant jobs:** the organization comes from the transaction; an A-job can't touch B's data; tenant jobs are refused outside a tenant transaction; platform jobs get no tenant access.
- **Transaction boundaries:** a rolled-back enqueue leaves no job; a job is invisible until its enqueue commits; a handler's writes roll back on failure.
- **Kick and retention:** the kick runs only the kicked types; `jobs.cleanup` retention is exact and idempotent.

Mutation checks:
- Removing `FOR UPDATE SKIP LOCKED` fails both concurrency tests.
- Removing the fence fails the stale-runner test.

`src/platform/jobs/definition.test.ts` covers naming, the registry and backoff bounds. `tests/e2e/cron.spec.ts` shows both cron routes return 404 without the secret, or with a wrong or malformed one. With it, the runner runs and the daily route enqueues `jobs.cleanup` once.

## Consequences

- Handlers must be idempotent and must not assume they run once.
- A job stuck behind a crashed runner is delayed up to 15 minutes unless its type sets a shorter `lockSeconds`.
- Throughput is one job at a time per invocation. That is ample for V1 (long-term D-22 names the triggers to revisit it); per-type concurrency caps come with `media.process` if it ever becomes a job.
