import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import { siteSettings } from "@/modules/sites/schema";
import { withPlatform, withTenant } from "@/platform/db/tenant";
import { jobs } from "@/platform/jobs/schema";
import { setLogSink } from "@/platform/observability/logger";
import { createTenantGraph } from "../fixtures/factories";

// kickJobs uses next/server's after(); outside a request we capture and run the callbacks ourselves.
const afterCallbacks: (() => Promise<unknown>)[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => afterCallbacks.push(fn) }));

const {
  backoffSeconds, createJobRegistry, defineJob, enqueue, enqueuePlatformJob, jobsCleanup, kickJobs, PermanentJobError, runJobs,
} = await import("@/platform/jobs");
const { claimNext } = await import("@/platform/jobs/runner");

/**
 * M1-3: the Postgres job queue against real Postgres through PgBouncer
 * (transaction mode, as on Neon), as forge_app. Every test uses its own job
 * types, so runners in one test never touch another test's jobs.
 */

type Graph = Awaited<ReturnType<typeof createTenantGraph>>;
let A: Graph;
let B: Graph;
const logs: Record<string, unknown>[] = [];

beforeAll(async () => {
  setLogSink((_level, line) => logs.push(JSON.parse(line)));
  [A, B] = await Promise.all([createTenantGraph(), createTenantGraph()]);
});
afterAll(() => setLogSink(null));

const suffix = () => randomBytes(3).toString("hex");
const fixedRandom = () => 0.5;

/** A fake clock, one second ahead of the database so freshly enqueued jobs are due. */
function fakeClock() {
  let t = Date.now() + 1_000;
  return { now: () => new Date(t), advance: (seconds: number) => void (t += seconds * 1_000), at: () => new Date(t) };
}

async function row(id: string) {
  const [r] = await withPlatform((tx) => tx.select().from(jobs).where(eq(jobs.id, id)));
  return r!;
}

async function countOfType(type: string) {
  const { rows } = await withPlatform((tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from jobs where type = ${type}`));
  return rows[0]!.n;
}

function recordingJob(scope: "tenant" | "platform" = "platform", run?: (payload: { n: number }) => Promise<void>) {
  const calls: { n: number }[] = [];
  const job = defineJob({
    type: `test.record_${suffix()}`,
    scope,
    payload: z.object({ n: z.number().int() }),
    run: async (payload) => {
      calls.push(payload);
      await run?.(payload);
    },
  });
  return { job, calls, registry: createJobRegistry([job]) };
}

describe("enqueue", () => {
  it("adds a queued job inside the caller's transaction, with the validated payload", async () => {
    const { job } = recordingJob();
    const { id, deduplicated } = await withPlatform((tx) => enqueue(tx, job, { n: 1, extra: "dropped" } as never));
    expect(deduplicated).toBe(false);
    expect(await row(id)).toMatchObject({ type: job.type, status: "queued", attempts: 0, maxAttempts: 5, organizationId: null, payload: { n: 1 } });
  });

  it("rejects an invalid payload and writes nothing", async () => {
    const { job } = recordingJob();
    await expect(withPlatform((tx) => enqueue(tx, job, { n: "one" } as never))).rejects.toBeInstanceOf(ZodError);
    expect(await countOfType(job.type)).toBe(0);
  });

  it("dedupes on a natural key while a job is queued or running, then allows it again", async () => {
    const { job, registry } = recordingJob();
    const first = await enqueuePlatformJob(job, { n: 1 }, { dedupeKey: `dedupe:${job.type}` });
    const second = await enqueuePlatformJob(job, { n: 2 }, { dedupeKey: `dedupe:${job.type}` });
    expect(second).toEqual({ id: first.id, deduplicated: true });
    expect(await countOfType(job.type)).toBe(1);

    await runJobs({ registry, budgetMs: 10_000 });
    const third = await enqueuePlatformJob(job, { n: 3 }, { dedupeKey: `dedupe:${job.type}` });
    expect(third.deduplicated).toBe(false);
    expect(third.id).not.toBe(first.id);
  });
});

describe("runner: success, retry, dead-letter, permanent failure", () => {
  it("claims a due job, runs it, and marks it succeeded", async () => {
    const { job, calls, registry } = recordingJob();
    const { id } = await enqueuePlatformJob(job, { n: 7 });
    const summary = await runJobs({ registry, budgetMs: 10_000 });
    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, stoppedBy: "empty" });
    expect(calls).toEqual([{ n: 7 }]);
    const r = await row(id);
    expect(r).toMatchObject({ status: "succeeded", attempts: 1, lockedUntil: null, lastError: null });
    expect(r.finishedAt).toBeInstanceOf(Date);
  });

  it("does not run jobs scheduled for later", async () => {
    const clock = fakeClock();
    const { job, calls, registry } = recordingJob();
    await enqueuePlatformJob(job, { n: 1 }, { runAt: new Date(clock.at().getTime() + 60_000) });
    expect((await runJobs({ registry, budgetMs: 10_000, now: clock.now })).claimed).toBe(0);
    clock.advance(61);
    expect((await runJobs({ registry, budgetMs: 10_000, now: clock.now })).succeeded).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("retries with exponential backoff and jitter, then succeeds", async () => {
    const clock = fakeClock();
    let failuresLeft = 2;
    const { job, registry } = recordingJob("platform", async () => {
      if (failuresLeft-- > 0) throw new Error("provider timeout");
    });
    const { id } = await enqueuePlatformJob(job, { n: 1 });

    const run = () => runJobs({ registry, budgetMs: 10_000, now: clock.now, random: fixedRandom });
    expect((await run()).retried).toBe(1);
    const afterFirst = await row(id);
    const firstDelay = backoffSeconds(1, undefined, fixedRandom); // 30 s base → between 15 and 30
    expect(afterFirst).toMatchObject({ status: "queued", attempts: 1, lastError: "Error: provider timeout" });
    expect(afterFirst.runAt.getTime()).toBe(clock.at().getTime() + firstDelay * 1_000);

    expect((await run()).claimed).toBe(0); // not due yet
    clock.advance(firstDelay);
    expect((await run()).retried).toBe(1);
    const secondDelay = backoffSeconds(2, undefined, fixedRandom);
    expect(secondDelay).toBeGreaterThan(firstDelay);

    clock.advance(secondDelay);
    expect((await run()).succeeded).toBe(1);
    expect(await row(id)).toMatchObject({ status: "succeeded", attempts: 3 });
  });

  it("moves a job to dead after max attempts", async () => {
    const clock = fakeClock();
    const { job, calls, registry } = recordingJob("platform", async () => {
      throw new Error("always down");
    });
    const { id } = await enqueuePlatformJob(job, { n: 1 }, { maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      await runJobs({ registry, budgetMs: 10_000, now: clock.now, random: fixedRandom });
      clock.advance(3_600);
    }
    expect(await runJobs({ registry, budgetMs: 10_000, now: clock.now })).toMatchObject({ claimed: 0 });
    expect(calls).toHaveLength(3);
    const r = await row(id);
    expect(r).toMatchObject({ status: "dead", attempts: 3, lastError: "Error: always down" });
    expect(r.finishedAt).toBeInstanceOf(Date);
  });

  it("a PermanentJobError fails the job without retrying", async () => {
    const { job, calls, registry } = recordingJob("platform", async () => {
      throw new PermanentJobError("recipient does not exist");
    });
    const { id } = await enqueuePlatformJob(job, { n: 1 });
    expect(await runJobs({ registry, budgetMs: 10_000 })).toMatchObject({ failed: 1, retried: 0 });
    expect(calls).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("a stored payload that no longer validates fails without calling the handler", async () => {
    const { job, calls, registry } = recordingJob();
    const { id } = await enqueuePlatformJob(job, { n: 1 });
    await withPlatform((tx) => tx.update(jobs).set({ payload: { n: "not a number" } }).where(eq(jobs.id, id)));
    expect(await runJobs({ registry, budgetMs: 10_000 })).toMatchObject({ failed: 1 });
    expect(calls).toHaveLength(0);
    expect((await row(id)).lastError).toMatch(/^Invalid payload/);
  });

  it("leaves job types it doesn't know alone (e.g. enqueued by a newer deployment)", async () => {
    const { job } = recordingJob();
    const other = recordingJob();
    const { id } = await enqueuePlatformJob(job, { n: 1 });
    await runJobs({ registry: other.registry, budgetMs: 10_000 });
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("stops claiming once 75% of the time budget is spent", async () => {
    const { job, calls, registry } = recordingJob("platform", () => new Promise((r) => setTimeout(r, 60)));
    for (let i = 0; i < 5; i++) await enqueuePlatformJob(job, { n: i });
    const summary = await runJobs({ registry, budgetMs: 100 }); // 75 ms of claiming
    expect(summary.stoppedBy).toBe("budget");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThan(5);
  });
});

describe("concurrency", () => {
  it("concurrent claimers never get the same job", async () => {
    const { job, registry } = recordingJob();
    for (let i = 0; i < 8; i++) await enqueuePlatformJob(job, { n: i });
    const claims = await Promise.all(Array.from({ length: 20 }, () => claimNext(registry)));
    const ids = claims.filter((c) => c !== null).map((c) => c!.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    // These claims are never completed; remove them so later reaper tests only see their own.
    await withPlatform((tx) => tx.delete(jobs).where(eq(jobs.type, job.type)));
  });

  it("four runners in parallel process every job exactly once", async () => {
    const { job, calls, registry } = recordingJob("platform", () => new Promise((r) => setTimeout(r, 5)));
    for (let i = 0; i < 40; i++) await enqueuePlatformJob(job, { n: i });
    const summaries = await Promise.all(Array.from({ length: 4 }, () => runJobs({ registry, budgetMs: 20_000 })));
    expect(summaries.reduce((sum, s) => sum + s.succeeded, 0)).toBe(40);
    expect(calls.map((c) => c.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(summaries.filter((s) => s.claimed > 0).length).toBeGreaterThan(1); // the work really was shared
  });

  it("a crashed runner's claim is reaped after it expires and the job runs again", async () => {
    const clock = fakeClock();
    const { job, calls, registry } = recordingJob();
    const { id } = await enqueuePlatformJob(job, { n: 1 });
    await claimNext(registry, clock.now); // claimed, then the "runner" dies
    expect(await runJobs({ registry, budgetMs: 10_000, now: clock.now })).toMatchObject({ claimed: 0 });
    clock.advance(901); // past the default 900 s claim
    const summary = await runJobs({ registry, budgetMs: 10_000, now: clock.now });
    expect(summary.reaped.requeued).toBeGreaterThanOrEqual(1); // the reaper sweeps every job type
    expect(summary.succeeded).toBe(1);
    expect(calls).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("a runner that lost its claim cannot overwrite the newer outcome (duplicate execution is safe)", async () => {
    const clock0 = fakeClock();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const firstRunEntered = new Promise<void>((r) => (entered = r));
    let invocation = 0;
    const job = defineJob({
      type: `test.slow_${suffix()}`,
      scope: "platform",
      lockSeconds: 60,
      payload: z.object({}),
      run: async () => {
        if (++invocation === 1) {
          entered();
          await gate;
          throw new Error("late failure from the stale runner");
        }
      },
    });
    const registry = createJobRegistry([job]);
    const { id } = await enqueuePlatformJob(job, {});

    const stale = runJobs({ registry, budgetMs: 10_000, now: clock0.now, maxJobs: 1 });
    await firstRunEntered;
    const later = () => new Date(clock0.at().getTime() + 61_000); // the 60 s claim has expired
    const fresh = await runJobs({ registry, budgetMs: 10_000, now: later, maxJobs: 1 });
    expect(fresh.succeeded).toBe(1);
    expect(fresh.reaped.requeued).toBeGreaterThanOrEqual(1);

    release();
    expect(await stale).toMatchObject({ lostClaim: 1, retried: 0 });
    expect(await row(id)).toMatchObject({ status: "succeeded", attempts: 2 }); // not flipped back to queued
  });
});

describe("tenant jobs", () => {
  const touch = defineJob({
    type: "test.tenant_touch",
    scope: "tenant",
    payload: z.object({ siteId: z.uuid(), tagline: z.string() }),
    run: async ({ siteId, tagline }, ctx) => {
      const updated = await ctx.withTenant((tx) =>
        tx
          .update(siteSettings)
          .set({ general: sql`${siteSettings.general} || jsonb_build_object('tagline', ${tagline}::text)` })
          .where(eq(siteSettings.siteId, siteId))
          .returning({ siteId: siteSettings.siteId }),
      );
      seen.push({ orgId: ctx.orgId, updated: updated.length });
    },
  });
  const registry = createJobRegistry([touch]);
  const seen: { orgId: string | null; updated: number }[] = [];
  const tagline = async (g: Graph) =>
    (await withTenant({ orgId: g.org.id }, (tx) => tx.select().from(siteSettings).where(eq(siteSettings.siteId, g.site.id))))[0]!
      .general.tagline;

  it("records the enqueuing transaction's organization and runs the handler in it", async () => {
    seen.length = 0;
    const { id } = await withTenant({ orgId: A.org.id, userId: A.user.id }, (tx) =>
      enqueue(tx, touch, { siteId: A.site.id, tagline: "from job" }),
    );
    expect((await row(id)).organizationId).toBe(A.org.id);
    await runJobs({ registry, budgetMs: 10_000 });
    expect(seen).toEqual([{ orgId: A.org.id, updated: 1 }]);
    expect(await tagline(A)).toBe("from job");
    const line = logs.find((l) => l.msg === "job succeeded" && l.jobId === id);
    expect(line).toMatchObject({ orgId: A.org.id, module: "jobs", jobType: touch.type, attempt: 1 });
  });

  it("an organization A job cannot touch organization B's data, even with B's ids in its payload", async () => {
    seen.length = 0;
    const before = await tagline(B);
    await withTenant({ orgId: A.org.id }, (tx) => enqueue(tx, touch, { siteId: B.site.id, tagline: "hijack" }));
    await runJobs({ registry, budgetMs: 10_000 });
    expect(seen).toEqual([{ orgId: A.org.id, updated: 0 }]);
    expect(await tagline(B)).toBe(before);
  });

  it("a tenant job must be enqueued inside a tenant transaction", async () => {
    const before = await countOfType(touch.type);
    await expect(withPlatform((tx) => enqueue(tx, touch, { siteId: A.site.id, tagline: "x" }))).rejects.toThrow(
      /inside withTenant/,
    );
    expect(await countOfType(touch.type)).toBe(before);
  });

  it("a platform job enqueued from a tenant transaction has no organization, and no tenant access", async () => {
    const job = defineJob({
      type: `test.platform_${suffix()}`,
      scope: "platform",
      payload: z.object({}),
      run: async (_p, ctx) => {
        await ctx.withTenant(async () => undefined);
      },
    });
    const { id } = await withTenant({ orgId: A.org.id }, (tx) => enqueue(tx, job, {}));
    expect((await row(id)).organizationId).toBeNull();
    expect(await runJobs({ registry: createJobRegistry([job]), budgetMs: 10_000 })).toMatchObject({ failed: 1 });
  });
});

describe("inherit scope and payload redaction", () => {
  it("an inherit job takes the transaction's tenant when there is one, and none otherwise", async () => {
    const seen: (string | null)[] = [];
    const job = defineJob({
      type: `test.inherit_${suffix()}`,
      scope: "inherit",
      payload: z.object({}),
      run: async (_p, ctx) => {
        seen.push(ctx.orgId);
        if (ctx.orgId) await ctx.withTenant(async (tx) => tx.execute(sql`select 1`));
      },
    });
    const inTenant = await withTenant({ orgId: A.org.id }, (tx) => enqueue(tx, job, {}));
    const outside = await enqueuePlatformJob(job, {});
    expect((await row(inTenant.id)).organizationId).toBe(A.org.id);
    expect((await row(outside.id)).organizationId).toBeNull();
    expect(await runJobs({ registry: createJobRegistry([job]), budgetMs: 10_000 })).toMatchObject({ succeeded: 2 });
    expect(seen.sort()).toEqual([A.org.id, null].sort());
  });

  it("redactOnFinish replaces the stored payload when a job finishes, including when it dies", async () => {
    const clock = fakeClock();
    const job = defineJob({
      type: `test.redact_${suffix()}`,
      scope: "platform",
      maxAttempts: 2,
      payload: z.object({ link: z.string() }),
      redactOnFinish: () => ({ link: "[redacted]" }),
      run: async () => {
        throw new Error("down");
      },
    });
    const { id } = await enqueuePlatformJob(job, { link: "https://x/secret" });
    const registry = createJobRegistry([job]);
    await runJobs({ registry, budgetMs: 10_000, now: clock.now, random: fixedRandom });
    expect((await row(id)).payload).toEqual({ link: "https://x/secret" }); // still needed for the retry
    clock.advance(3_600);
    await runJobs({ registry, budgetMs: 10_000, now: clock.now, random: fixedRandom });
    expect(await row(id)).toMatchObject({ status: "dead", payload: { link: "[redacted]" } });
  });
});

describe("transaction boundaries (through the pooler)", () => {
  it("a rolled-back business transaction leaves no job", async () => {
    const { job } = recordingJob();
    await expect(
      withPlatform(async (tx) => {
        await enqueue(tx, job, { n: 1 });
        throw new Error("business rule failed");
      }),
    ).rejects.toThrow("business rule failed");
    expect(await countOfType(job.type)).toBe(0);
  });

  it("a runner can't see a job until the enqueuing transaction commits", async () => {
    const { job, calls, registry } = recordingJob();
    let commit!: () => void;
    const committed = new Promise<void>((r) => (commit = r));
    let enqueued!: () => void;
    const didEnqueue = new Promise<void>((r) => (enqueued = r));
    const transaction = withPlatform(async (tx) => {
      await enqueue(tx, job, { n: 1 });
      enqueued();
      await committed;
    });
    await didEnqueue;
    expect((await runJobs({ registry, budgetMs: 10_000 })).claimed).toBe(0);
    commit();
    await transaction;
    expect((await runJobs({ registry, budgetMs: 10_000 })).succeeded).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("a handler's tenant writes roll back when it fails, and the job is retried", async () => {
    const before = (await withTenant({ orgId: A.org.id }, (tx) =>
      tx.select().from(siteSettings).where(eq(siteSettings.siteId, A.site.id)),
    ))[0]!.general.tagline;
    const job = defineJob({
      type: `test.rollback_${suffix()}`,
      scope: "tenant",
      payload: z.object({ siteId: z.uuid() }),
      run: async ({ siteId }, ctx) => {
        await ctx.withTenant(async (tx) => {
          await tx
            .update(siteSettings)
            .set({ general: sql`${siteSettings.general} || '{"tagline":"half-done"}'::jsonb` })
            .where(eq(siteSettings.siteId, siteId));
          throw new Error("failed after writing");
        });
      },
    });
    const { id } = await withTenant({ orgId: A.org.id }, (tx) => enqueue(tx, job, { siteId: A.site.id }));
    expect(await runJobs({ registry: createJobRegistry([job]), budgetMs: 10_000 })).toMatchObject({ retried: 1 });
    const after = (await withTenant({ orgId: A.org.id }, (tx) =>
      tx.select().from(siteSettings).where(eq(siteSettings.siteId, A.site.id)),
    ))[0]!.general.tagline;
    expect(after).toBe(before);
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 1 });
  });
});

describe("kickJobs (after())", () => {
  it("runs the kicked job types after the response, and only those", async () => {
    const kicked = recordingJob();
    const notKicked = recordingJob();
    const { id } = await enqueuePlatformJob(kicked.job, { n: 1 });
    const other = await enqueuePlatformJob(notKicked.job, { n: 2 });
    afterCallbacks.length = 0;
    kickJobs([kicked.job]);
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]!();
    expect(await row(id)).toMatchObject({ status: "succeeded" });
    expect(await row(other.id)).toMatchObject({ status: "queued" }); // left for the cron runner
  });
});

describe("jobs.cleanup (daily retention)", () => {
  it("deletes finished jobs after 14 days and dead/failed jobs after 30 days, and is idempotent", async () => {
    const type = `test.old_${suffix()}`;
    const ago = (days: number) => sql`now() - make_interval(days => ${days})`;
    const insert = (status: string, days: number) =>
      withPlatform((tx) =>
        tx.execute<{ id: string }>(sql`
          insert into jobs (id, type, status, finished_at, created_at)
          values (gen_random_uuid(), ${type}, ${status}, ${ago(days)}, ${ago(days)}) returning id`),
      ).then((r) => ({ status, days, id: r.rows[0]!.id }));
    const rows = await Promise.all([
      insert("succeeded", 15), insert("succeeded", 13), insert("canceled", 15),
      insert("dead", 15), insert("dead", 31), insert("failed", 31),
    ]);

    await enqueuePlatformJob(jobsCleanup, {});
    const registry = createJobRegistry([jobsCleanup]);
    expect(await runJobs({ registry, budgetMs: 10_000 })).toMatchObject({ succeeded: 1 });
    const { rows: left } = await withPlatform((tx) =>
      tx.execute<{ id: string }>(sql`select id from jobs where type = ${type}`),
    );
    const remaining = new Set(left.map((r) => r.id));
    expect(rows.filter((r) => remaining.has(r.id)).map((r) => `${r.status}:${r.days}`).sort()).toEqual([
      "dead:15", "succeeded:13",
    ]);

    await enqueuePlatformJob(jobsCleanup, {});
    await runJobs({ registry, budgetMs: 10_000 });
    expect(await countOfType(type)).toBe(2);
  });
});
