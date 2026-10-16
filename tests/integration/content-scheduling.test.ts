import { and, eq, inArray, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jobRegistry } from "@/app/api/internal/cron/jobs";
import { queryActivity, recordSystem } from "@/modules/audit";
import {
  cancelSchedule, changeAuthor, createEntry, deleteTerm, formatInZone, publishDue, publishEntry, publishScheduled, purgeTrashedEntries, rescheduleEntry, saveDraft,
  scheduleEntry, submitScheduleEntry, toLocalInput, trashEntry, trashPurge, unpublishEntry, zonedToUtc,
} from "@/modules/content";
import { createSite } from "@/modules/sites";
import { changeMemberRole, inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import { tags } from "@/platform/cache";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { createJobRegistry, runJobs } from "@/platform/jobs";
import { whileFailing } from "../fixtures/db-failure";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// The public reads' cache calls are noted (the tags each read applies), and so are the flushes, so the tests can check
// that a scheduled publish flushes, at once, every read that would show the entry, and that a failure flushes nothing.
const cache = vi.hoisted(() => ({ applied: [] as string[], revalidated: [] as { tag: string; profile: unknown }[], updated: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  cacheLife: () => {},
  cacheTag: (...names: string[]) => void cache.applied.push(...names),
  revalidateTag: (tag: string, profile: unknown) => void cache.revalidated.push({ tag, profile }),
  updateTag: (tag: string) => void cache.updated.push(tag),
}));
const { loadPublicSite, publicPageFor, resolveSite } = await import("@/modules/rendering");

/**
 * M7-2 against real Postgres through PgBouncer: scheduling, the queue's job that publishes at the time (run here by the
 * real runner on a fake clock), the system actor that records what it does, and `trash.purge`'s own records.
 */

type Tenant = Awaited<ReturnType<typeof newTenant>>;
const ZONE = "Asia/Manila";
const HOUR = 3_600_000;
const onlyScheduling = createJobRegistry([publishScheduled]);

async function liveSite(tenant: Tenant, name = "Schedules", timezone = ZONE) {
  const address = newSlug("sched");
  const { site } = await createSite(tenant.ctx, { name, address, language: "en", timezone });
  const ctx = await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug);
  await withTenant({ orgId: tenant.org.id }, (tx) => tx.update(t.sites).set({ status: "live" }).where(eq(t.sites.id, site.id)));
  return { site, ctx, address };
}
const doc = (...texts: string[]) => ({ v: 1, doc: { type: "doc", content: texts.map((text) => ({ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] })) } });
const versionOf = async (ctx: SiteContext, entryId: string) =>
  (await inTenant(ctx, (tx) => tx.select({ version: t.entryDrafts.version }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, entryId))))[0]!.version;
const rowOf = async (ctx: SiteContext, id: string) => (await inTenant(ctx, (tx) => tx.select().from(t.entries).where(eq(t.entries.id, id))))[0] ?? null;
const records = (ctx: SiteContext, action: string) =>
  inTenant(ctx, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, action))));
const publicSite = async (address: string) => {
  const resolved = (await resolveSite({ kind: "address", address }))!;
  return (await loadPublicSite(resolved.orgId, resolved.siteId))!;
};
const at = async (address: string, path: string) => publicPageFor(await publicSite(address), path === "/" ? [] : path.slice(1).split("/"));
const textOf = (page: Awaited<ReturnType<typeof at>>) => (page?.kind === "entry" ? JSON.stringify(page.entry.content) : null);
/** A wall-clock time in the zone this far ahead (whole minutes), and the instant it is. */
function later(ms: number, zone = ZONE) {
  const local = toLocalInput(new Date(Date.now() + ms), zone);
  const result = zonedToUtc(local, zone);
  if (!result.ok) throw new Error(`no instant for ${local}`);
  return { local, at: result.at };
}
async function schedule(ctx: SiteContext, entryId: string, ms = 2 * HOUR, draft: Record<string, unknown> = {}) {
  if (Object.keys(draft).length) await saveDraft(ctx, entryId, await versionOf(ctx, entryId), draft);
  const when = later(ms);
  const result = await scheduleEntry(ctx, entryId, { runAt: when.local, version: await versionOf(ctx, entryId) });
  return { ...result, when };
}
/** The queue's runner, as the cron route runs it, on a clock just past `instant`: only the scheduling job. */
const runAt = (instant: Date, registry = onlyScheduling) => runJobs({ registry, budgetMs: 20_000, now: () => new Date(instant.getTime() + 1_000) });
/** The jobs table has no RLS: read it as the platform does. */
const { withPlatform } = await import("@/platform/db");
const jobsFor = (entryId: string) => withPlatform((tx) => tx.select().from(t.jobs).where(eq(t.jobs.dedupeKey, `entry:${entryId}`)));

afterAll(() => vi.restoreAllMocks());
beforeAll(() => {
  cache.applied.length = 0;
});

describe("scheduling a draft", () => {
  it("freezes it as a scheduled revision, queues the job for the instant typed in the site's zone, records it, and shows nothing yet", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Rye season" });
    const { when, runAt: instant } = await schedule(ctx, entry.id, 3 * HOUR, { content: doc("Dark and sour.") });
    expect(instant).toEqual(when.at);

    const row = (await rowOf(ctx, entry.id))!;
    expect(row).toMatchObject({ status: "scheduled", scheduledAt: when.at, publishedRevisionId: null, scheduleFailure: null });
    const revisions = await inTenant(ctx, (tx) => tx.select().from(t.entryRevisions).where(eq(t.entryRevisions.entryId, entry.id)));
    expect(revisions.map((r) => r.kind)).toEqual(["scheduled"]);
    const jobs = await jobsFor(entry.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "entry.publish_scheduled", status: "queued", runAt: when.at, organizationId: a.org.id, payload: { entryId: entry.id, revisionId: revisions[0]!.id } });
    expect((await records(ctx, "entry.scheduled"))[0]).toMatchObject({ actorType: "user", actorId: a.user.id, metadata: { runAt: when.at.toISOString(), type: "post" } });
    // Not public: a scheduled entry is not a published one.
    expect(await at(address, row.path)).toBeNull();
    expect(await at(address, "/blog")).toMatchObject({ posts: [] });
  });

  it("the site's zone, not the server's: the same wall-clock time is another instant in another zone", async () => {
    const a = await newTenant();
    const manila = await liveSite(a, "Manila", "Asia/Manila");
    const york = await liveSite(a, "New York", "America/New_York");
    const local = toLocalInput(new Date(Date.now() + 26 * HOUR), "UTC");
    const one = (await createEntry(manila.ctx, { type: "post", title: "One" })).entry;
    const two = (await createEntry(york.ctx, { type: "post", title: "Two" })).entry;
    const first = await scheduleEntry(manila.ctx, one.id, { runAt: local, version: 1 });
    const second = await scheduleEntry(york.ctx, two.id, { runAt: local, version: 1 });
    expect(first.runAt).toEqual((zonedToUtc(local, "Asia/Manila") as { at: Date }).at);
    expect(second.runAt).toEqual((zonedToUtc(local, "America/New_York") as { at: Date }).at);
    expect(second.runAt.getTime() - first.runAt.getTime()).toBeGreaterThanOrEqual(11 * HOUR);
  });

  it("refused: a time in the past or within the minute, more than two years ahead, malformed, or one the clocks skip; a published or scheduled entry; a newer save", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a, "Refusals", "America/New_York");
    const { entry } = await createEntry(ctx, { type: "post", title: "Refused" });
    const fieldOf = async (runAt: unknown) => (await refusalOf(() => scheduleEntry(ctx, entry.id, { runAt, version: 1 }))).fieldErrors?.runAt?.[0];
    expect(await fieldOf(toLocalInput(new Date(Date.now() - HOUR), "America/New_York"))).toBe("Choose a time at least a minute from now. To publish now, use Publish.");
    expect(await fieldOf(toLocalInput(new Date(Date.now() + 3 * 365 * 24 * HOUR), "America/New_York"))).toBe("Choose a time within the next two years.");
    expect(await fieldOf("tomorrow at nine")).toBe("Enter a date and a time.");
    expect(await fieldOf("2027-03-14T02:30")).toBe("That time does not exist in America/New_York: the clocks skip it. Choose another.");
    expect(await fieldOf("2027-11-07T01:30")).toBe("That time happens twice in America/New_York: the clocks go back over it. Choose another.");
    expect((await refusalOf(() => scheduleEntry(ctx, entry.id, { runAt: later(2 * HOUR, "America/New_York").local, version: 7 }))).kind).toBe("Conflict");
    expect(await jobsFor(entry.id)).toEqual([]);
    expect((await rowOf(ctx, entry.id))!.status).toBe("draft");

    await publishEntry(ctx, entry.id, 1);
    expect((await refusalOf(() => scheduleEntry(ctx, entry.id, { runAt: later(2 * HOUR, "America/New_York").local, version: 1 }))).message).toBe("It is published.");
  });

  it("who may: the publish right; an Author their own posts and no pages; a Viewer is refused", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const author = await addMember(a.org, "author");
    const viewer = await addMember(a.org, "viewer");
    const editor = await addMember(a.org, "editor");
    const authorCtx = await resolveSiteContext(author.actor, a.org.slug, site.slug);
    const viewerCtx = await resolveSiteContext(viewer.actor, a.org.slug, site.slug);
    const editorCtx = await resolveSiteContext(editor.actor, a.org.slug, site.slug);
    const theirs = (await createEntry(ctx, { type: "post", title: "Owner's" })).entry;
    const mine = (await createEntry(authorCtx, { type: "post", title: "Mine" })).entry;
    const page = (await createEntry(ctx, { type: "page", title: "A page" })).entry;
    const when = later(2 * HOUR).local;
    expect((await refusalOf(() => scheduleEntry(authorCtx, theirs.id, { runAt: when, version: 1 }))).kind).toBe("NotFound");
    expect((await refusalOf(() => scheduleEntry(authorCtx, page.id, { runAt: when, version: 1 }))).kind).toBe("NotFound");
    expect((await refusalOf(() => scheduleEntry(viewerCtx, theirs.id, { runAt: when, version: 1 }))).kind).toBe("Forbidden");
    expect(await scheduleEntry(authorCtx, mine.id, { runAt: when, version: 1 })).toMatchObject({ entry: { status: "scheduled" } });
    expect(await scheduleEntry(editorCtx, page.id, { runAt: when, version: 1 })).toMatchObject({ entry: { status: "scheduled" } });
    expect((await refusalOf(() => cancelSchedule(viewerCtx, page.id))).kind).toBe("Forbidden");
    expect((await refusalOf(() => cancelSchedule(authorCtx, page.id))).kind).toBe("NotFound");
  });

  it("the form: its field error says what is wrong; the zone is the site's, whatever the browser sends", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Form" });
    const form = (fields: Record<string, string>) => {
      const data = new FormData();
      for (const [key, value] of Object.entries(fields)) data.set(key, value);
      return data;
    };
    expect(await submitScheduleEntry(a.actor, a.org.slug, site.slug, entry.id, form({ runAt: "2020-01-01T10:00", version: "1" }))).toMatchObject({
      refused: "Validation", state: { status: "error", fieldErrors: { runAt: ["Choose a time at least a minute from now. To publish now, use Publish."] } },
    });
    const when = later(5 * HOUR);
    const outcome = await submitScheduleEntry(a.actor, a.org.slug, site.slug, entry.id, form({ runAt: when.local, version: "1", timeZone: "UTC" }));
    expect(outcome).toMatchObject({ state: { status: "success", message: "Scheduled.", values: { scheduledAt: when.at.toISOString() } } });
  });
});

describe("the job, on the queue's clock", () => {
  it("publishes the frozen revision at its time, not what was typed after: within one run, as the system, flushing what the public reads applied, exactly once", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const bread = (await inTenant(ctx, (tx) => tx.insert(t.terms).values({ organizationId: a.org.id, siteId: ctx.site.id, taxonomy: "category", name: "Bread", slug: "bread" }).returning()))[0]!;
    const { entry } = await createEntry(ctx, { type: "post", title: "Rye season" });
    const { when } = await schedule(ctx, entry.id, 2 * HOUR, { content: doc("The scheduled words."), termIds: [bread.id] });
    // Typed after scheduling: saved to the draft, never published by the schedule.
    await saveDraft(ctx, entry.id, await versionOf(ctx, entry.id), { content: doc("Words typed later.") });

    // Before its time: nothing.
    expect(await runJobs({ registry: onlyScheduling, budgetMs: 20_000, now: () => new Date(when.at.getTime() - 60_000) })).toMatchObject({ claimed: 0 });
    expect((await rowOf(ctx, entry.id))!.status).toBe("scheduled");

    // What the public reads apply while it is not public (the blog, the archive, the path).
    cache.applied.length = 0;
    await at(address, "/blog");
    await at(address, "/blog/category/bread");
    await at(address, (await rowOf(ctx, entry.id))!.path);
    const tagged = new Set(cache.applied);
    cache.revalidated.length = 0;

    // The runner takes every due job (others' of earlier tests too): this one's row says how it went.
    expect(await runAt(when.at)).toMatchObject({ failed: 0, dead: 0, retried: 0 });
    expect((await jobsFor(entry.id))[0]).toMatchObject({ status: "succeeded", attempts: 1 });
    const row = (await rowOf(ctx, entry.id))!;
    expect(row).toMatchObject({ status: "published", scheduledAt: null, publishedAt: when.at });
    expect(row.firstPublishedAt).not.toBeNull();
    const shown = await at(address, row.path);
    expect(textOf(shown)).toContain("The scheduled words.");
    expect(textOf(shown)).not.toContain("Words typed later.");
    expect(await at(address, "/blog/category/bread")).toMatchObject({ posts: [{ title: "Rye season" }] });

    // The published revision is the scheduled one; the draft's later save shows as "changes since".
    const revisions = await inTenant(ctx, (tx) => tx.select().from(t.entryRevisions).where(eq(t.entryRevisions.entryId, entry.id)));
    expect(revisions).toHaveLength(1);
    expect(row.publishedRevisionId).toBe(revisions[0]!.id);
    expect(revisions[0]!.sourceDraftVersion).toBeLessThan(await versionOf(ctx, entry.id));

    // Recorded by the system, not a person.
    const published = await records(ctx, "entry.published");
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ actorType: "system", actorId: null, actorLabel: "Forge (scheduled publishing)", metadata: { scheduled: true, revision: 1 } });

    // Flushed with revalidateTag(…, { expire: 0 }) — every tag those reads applied that can show it.
    const flushed = new Set(cache.revalidated.filter((call) => JSON.stringify(call.profile) === JSON.stringify({ expire: 0 })).map((call) => call.tag));
    for (const tag of [tags.routes(ctx.site.id), tags.entry(ctx.site.id, entry.id)]) expect(flushed, tag).toContain(tag);
    expect(tagged.has(tags.list(ctx.site.id, "post"))).toBe(true);
    expect(cache.revalidated.some((call) => call.tag === tags.list(ctx.site.id, "post"))).toBe(true);
    expect(cache.updated).toEqual([]); // no request's updateTag: the job flushes in the background

    // Run again (a second delivery): nothing more.
    const payload = { entryId: entry.id, revisionId: revisions[0]!.id, runAt: when.at.toISOString() };
    expect(await withTenant({ orgId: a.org.id }, (tx) => publishDue(tx, a.org.id, payload))).toMatchObject({ kind: "already" });
    expect(await records(ctx, "entry.published")).toHaveLength(1);
    expect(await inTenant(ctx, (tx) => tx.select().from(t.entryRevisions).where(eq(t.entryRevisions.entryId, entry.id)))).toHaveLength(1);
  });

  it("two runs at once of one schedule publish it once: one publishes, the other finds it published", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    for (let round = 0; round < 4; round++) {
      const { entry } = await createEntry(ctx, { type: "post", title: `Twice ${round}` });
      const { when } = await schedule(ctx, entry.id);
      const [job] = await jobsFor(entry.id);
      const payload = job!.payload as { entryId: string; revisionId: string; runAt: string };
      const outcomes = await Promise.all([1, 2].map(() => withTenant({ orgId: a.org.id }, (tx) => publishDue(tx, a.org.id, payload))));
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["already", "published"]);
      expect((await records(ctx, "entry.published")).filter((r) => r.resourceId === entry.id)).toHaveLength(1);
      expect((await rowOf(ctx, entry.id))!.publishedAt).toEqual(when.at);
    }
  });

  it("canceled, or moved to another time: the old time publishes nothing; the new time does", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const one = (await createEntry(ctx, { type: "post", title: "Canceled" })).entry;
    const { when: first } = await schedule(ctx, one.id);
    expect(await cancelSchedule(ctx, one.id)).toMatchObject({ changed: true, entry: { status: "draft" } });
    expect((await jobsFor(one.id))[0]).toMatchObject({ status: "canceled" });
    await runAt(first.at);
    expect((await rowOf(ctx, one.id))!).toMatchObject({ status: "draft", scheduledAt: null });
    expect((await records(ctx, "entry.schedule_canceled"))[0]).toMatchObject({ actorType: "user", metadata: { runAt: first.at.toISOString() } });

    const two = (await createEntry(ctx, { type: "post", title: "Moved" })).entry;
    const { when: early } = await schedule(ctx, two.id, 2 * HOUR);
    const moved = later(5 * HOUR);
    expect(await rescheduleEntry(ctx, two.id, { runAt: moved.local })).toMatchObject({ changed: true, runAt: moved.at });
    const jobs = await jobsFor(two.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "queued", runAt: moved.at, payload: { runAt: moved.at.toISOString() } });
    await runAt(early.at);
    expect((await rowOf(ctx, two.id))!.status).toBe("scheduled");
    await runAt(moved.at);
    expect((await rowOf(ctx, two.id))!).toMatchObject({ status: "published", publishedAt: moved.at });
    expect((await records(ctx, "entry.scheduled")).find((r) => r.resourceId === two.id && (r.metadata as { previousRunAt?: string }).previousRunAt)).toMatchObject({
      metadata: { runAt: moved.at.toISOString(), previousRunAt: early.at.toISOString() },
    });
  });

  it("a cancel racing the job: whichever takes the entry first wins, never both; in rounds", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    for (let round = 0; round < 5; round++) {
      const { entry } = await createEntry(ctx, { type: "post", title: `Race ${round}` });
      await schedule(ctx, entry.id);
      const payload = (await jobsFor(entry.id))[0]!.payload as { entryId: string; revisionId: string; runAt: string };
      const [job, cancel] = await Promise.allSettled([withTenant({ orgId: a.org.id }, (tx) => publishDue(tx, a.org.id, payload)), cancelSchedule(ctx, entry.id)]);
      const row = (await rowOf(ctx, entry.id))!;
      if (row.status === "published") {
        expect(cancel.status === "rejected" && (cancel.reason as { message: string }).message).toBe("It is not scheduled.");
      } else {
        expect(row.status).toBe("draft");
        expect(job.status === "fulfilled" && job.value.kind).toBe("skipped");
      }
    }
  });

  it("a scheduled entry cannot be published by hand, unpublished or trashed until its schedule is canceled; its draft can still be edited", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Waiting" });
    await schedule(ctx, entry.id);
    const version = await versionOf(ctx, entry.id);
    expect((await refusalOf(() => publishEntry(ctx, entry.id, version))).message).toBe("It is scheduled. Cancel the schedule first.");
    expect((await refusalOf(() => unpublishEntry(ctx, entry.id))).message).toBe("It is not published.");
    expect((await refusalOf(() => trashEntry(ctx, entry.id))).message).toBe("It is scheduled. Cancel the schedule first, then move it to the trash.");
    expect(await saveDraft(ctx, entry.id, version, { title: "Still waiting" })).toEqual({ version: version + 1 });
  });

  it("a page scheduled under a draft parent gets its address under it; a post keeps its featured image and the terms still there (a deleted term is left out)", async () => {
    const a = await newTenant();
    const { ctx, address } = await liveSite(a);
    const parent = (await createEntry(ctx, { type: "page", title: "About" })).entry;
    const child = (await createEntry(ctx, { type: "page", title: "Team", parentId: parent.id })).entry;
    const { when } = await schedule(ctx, child.id);
    await runAt(when.at);
    expect((await rowOf(ctx, child.id))!).toMatchObject({ status: "published", path: "/about/team" });
    expect(await at(address, "/about/team")).toMatchObject({ kind: "entry", entry: { title: "Team" } });

    const keep = (await inTenant(ctx, (tx) => tx.insert(t.terms).values({ organizationId: a.org.id, siteId: ctx.site.id, taxonomy: "tag", name: "Keep", slug: "keep" }).returning()))[0]!;
    const drop = (await inTenant(ctx, (tx) => tx.insert(t.terms).values({ organizationId: a.org.id, siteId: ctx.site.id, taxonomy: "tag", name: "Drop", slug: "drop" }).returning()))[0]!;
    const post = (await createEntry(ctx, { type: "post", title: "Tagged" })).entry;
    const { when: postAt } = await schedule(ctx, post.id, 3 * HOUR, { termIds: [keep.id, drop.id] });
    await deleteTerm(ctx, drop.id);
    await runAt(postAt.at);
    expect((await rowOf(ctx, post.id))!.status).toBe("published");
    expect((await inTenant(ctx, (tx) => tx.select().from(t.entryTerms).where(eq(t.entryTerms.entryId, post.id)))).map((row) => row.termId)).toEqual([keep.id]);
  });
});

describe("when it cannot be published", () => {
  it("permanently (the scheduler may no longer publish it): a draft again with the reason, recorded by the system, an email to the scheduler; no retry, nothing flushed", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const editor = await addMember(a.org, "editor");
    const editorCtx = await resolveSiteContext(editor.actor, a.org.slug, site.slug);
    const { entry } = await createEntry(editorCtx, { type: "page", title: "Launch" });
    const { when } = await schedule(editorCtx, entry.id);
    await changeMemberRole(a.ctx, { memberId: editor.memberId, role: "viewer" });

    cache.revalidated.length = 0;
    await runAt(when.at);
    const row = (await rowOf(ctx, entry.id))!;
    expect(row).toMatchObject({ status: "draft", scheduledAt: null, publishedRevisionId: null, scheduleFailure: "The person who scheduled it can no longer publish it. Someone who can publishes or schedules it again." });
    expect(row.scheduleFailedAt).not.toBeNull();
    expect(cache.revalidated).toEqual([]);
    const failed = await records(ctx, "entry.schedule_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ actorType: "system", actorId: null, actorLabel: "Forge (scheduled publishing)", metadata: { runAt: when.at.toISOString(), reason: row.scheduleFailure } });
    const emails = await withPlatform((tx) => tx.select().from(t.jobs).where(and(eq(t.jobs.type, "email.send"), eq(t.jobs.organizationId, a.org.id))));
    expect(emails.map((job) => job.payload)).toContainEqual(expect.objectContaining({ template: "scheduled-publish-failed", userId: editor.user.id, title: "Launch", when: formatInZone(when.at, ZONE) }));
    expect((await jobsFor(entry.id))[0]).toMatchObject({ status: "succeeded" }); // settled: not retried

    // Scheduled again by someone who may, it publishes, and the failure note is gone.
    const { when: again } = await schedule(ctx, entry.id);
    expect((await rowOf(ctx, entry.id))!.scheduleFailure).toBeNull();
    await runAt(again.at);
    expect((await rowOf(ctx, entry.id))!.status).toBe("published");
  });

  it("an Author's post given to someone else is no longer theirs to publish: the schedule fails the same way", async () => {
    const a = await newTenant();
    const { ctx, site } = await liveSite(a);
    const author = await addMember(a.org, "author");
    const authorCtx = await resolveSiteContext(author.actor, a.org.slug, site.slug);
    const { entry } = await createEntry(authorCtx, { type: "post", title: "Mine for now" });
    const { when } = await schedule(authorCtx, entry.id);
    await changeAuthor(ctx, entry.id, a.user.id);
    await runAt(when.at);
    expect((await rowOf(ctx, entry.id))!).toMatchObject({ status: "draft", scheduleFailure: expect.stringContaining("can no longer publish it") });
  });

  /** A post in a category: publishing it writes its term link, which the forced failure below refuses. */
  async function categorized(ctx: SiteContext, title: string) {
    const term = (await inTenant(ctx, (tx) => tx.insert(t.terms).values({ organizationId: ctx.org.id, siteId: ctx.site.id, taxonomy: "category", name: title, slug: newSlug("c") }).returning()))[0]!;
    const { entry } = await createEntry(ctx, { type: "post", title });
    const { when } = await schedule(ctx, entry.id, 2 * HOUR, { termIds: [term.id] });
    return { entry, when };
  }

  it("transiently (the database refuses a write): rolled back whole and retried; nothing published or flushed meanwhile; then published", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry, when } = await categorized(ctx, "Retried");
    cache.revalidated.length = 0;
    await whileFailing("entry_terms", "insert", () => runAt(when.at));
    expect((await rowOf(ctx, entry.id))!).toMatchObject({ status: "scheduled", publishedRevisionId: null });
    expect(await records(ctx, "entry.published")).toEqual([]);
    expect(cache.revalidated.filter((call) => call.tag.includes(entry.id))).toEqual([]);
    const [job] = await jobsFor(entry.id);
    expect(job).toMatchObject({ status: "queued", attempts: 1, lastError: expect.stringMatching(/insert into "entry_terms"/) });
    await runAt(job!.runAt);
    expect((await rowOf(ctx, entry.id))!.status).toBe("published");
  });

  it("on the last attempt the entry is made a draft with a technical reason, and the job is dead (seen by whoever watches the queue)", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry, when } = await categorized(ctx, "Given up");
    await withPlatform((tx) => tx.update(t.jobs).set({ attempts: 4 }).where(eq(t.jobs.dedupeKey, `entry:${entry.id}`)));
    await whileFailing("entry_terms", "insert", () => runAt(when.at));
    expect((await rowOf(ctx, entry.id))!).toMatchObject({ status: "draft", scheduleFailure: "Forge could not reach its database or storage in time, after several tries." });
    expect((await jobsFor(entry.id))[0]).toMatchObject({ status: "dead" });
  });
});

describe("the system actor", () => {
  it("is written only in an organization's transaction with no user in it; a person's change is never the system's", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const { entry } = await createEntry(ctx, { type: "post", title: "Actor" });
    const event = { action: "entry.schedule_canceled" as const, resourceType: "entry" as const, resourceId: entry.id, siteId: ctx.site.id, metadata: { type: "post" as const, title: "Actor", path: entry.path, runAt: new Date().toISOString() } };
    expect(String(await refusalOrError(() => withTenant({ orgId: a.org.id, userId: a.user.id }, (tx) => recordSystem(tx, event, "entry.publish_scheduled"))))).toMatch(/no user in its context/);
    expect(String(await refusalOrError(() => withTenant({ orgId: a.org.id }, (tx) => recordSystem(tx, event, "a person" as never))))).toMatch(/not a system actor/);
    await withTenant({ orgId: a.org.id }, (tx) => recordSystem(tx, event, "trash.purge"));
    expect((await records(ctx, "entry.schedule_canceled"))[0]).toMatchObject({ actorType: "system", actorLabel: "Forge (trash cleanup)", organizationId: a.org.id });
    // Another organization sees none of it.
    const b = await newTenant();
    const theirs = await withTenant({ orgId: b.org.id, userId: b.user.id }, (tx) => queryActivity(tx, b.org.id));
    expect(theirs.items.some((item) => item.actorName.startsWith("Forge ("))).toBe(false);
  });
});

describe("trash.purge, recorded (M7-2)", () => {
  it("each entry it deletes is a line by the system, with the pages below it and how long it was in the trash; the lines outlive the rows", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const about = (await createEntry(ctx, { type: "page", title: "About" })).entry;
    const team = (await createEntry(ctx, { type: "page", title: "Team", parentId: about.id })).entry;
    const post = (await createEntry(ctx, { type: "post", title: "Old post" })).entry;
    await trashEntry(ctx, about.id);
    await trashEntry(ctx, post.id);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.entries).set({ deletedAt: sql`now() - interval '31 days'` }).where(inArray(t.entries.id, [about.id, team.id, post.id])));
    await purgeTrashedEntries();
    expect(await inTenant(ctx, (tx) => tx.select().from(t.entries).where(inArray(t.entries.id, [about.id, team.id, post.id])))).toEqual([]);
    const lines = (await records(ctx, "entry.deleted")).map((r) => ({ id: r.resourceId, actorType: r.actorType, label: r.actorLabel, metadata: r.metadata }));
    expect(lines).toEqual(
      expect.arrayContaining([
        { id: about.id, actorType: "system", label: "Forge (trash cleanup)", metadata: { type: "page", title: "About", path: "/about", below: 1, afterDays: 31 } },
        { id: post.id, actorType: "system", label: "Forge (trash cleanup)", metadata: { type: "post", title: "Old post", path: post.path, below: 0, afterDays: 31 } },
      ]),
    );
    expect(lines).toHaveLength(2); // Team went with About: in About's line, not one of its own
  });

  it("a record that cannot be written deletes nothing; the job says it failed and still purges media; the next run does it", async () => {
    const a = await newTenant();
    const { ctx } = await liveSite(a);
    const old = (await createEntry(ctx, { type: "post", title: "Kept for now" })).entry;
    await trashEntry(ctx, old.id);
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.entries).set({ deletedAt: sql`now() - interval '31 days'` }).where(eq(t.entries.id, old.id)));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as never;
    const run = () => trashPurge.run({}, { job: { id: uuidv7(), type: "trash.purge", attempt: 1, maxAttempts: 5 }, orgId: null, log, withTenant: () => Promise.reject(new Error("none")) });
    await expect(whileFailing("audit_logs", "insert", run)).rejects.toThrow(/trash\.purge: entries failed/);
    expect(await rowOf(ctx, old.id)).not.toBeNull();
    await run();
    expect(await rowOf(ctx, old.id)).toBeNull();
    expect((await records(ctx, "entry.deleted")).map((r) => r.resourceId)).toEqual([old.id]);
  });

  it("the registry runs the scheduling job; the daily jobs are unchanged", () => {
    expect(jobRegistry.get("entry.publish_scheduled")).toBe(publishScheduled);
  });
});

/** A thrown error's message, whatever threw it. */
async function refusalOrError(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
}
