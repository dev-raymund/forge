import "server-only";
import { z } from "zod";
import { record, recordSystem } from "@/modules/audit";
import { inTenant, type SiteContext } from "@/modules/tenancy";
import { invalidate, type CacheEvent } from "@/platform/cache";
import { env } from "@/platform/config/env";
import type { TenantTx } from "@/platform/db";
import { queueEmail } from "@/platform/email";
import { asAppError, conflict, forbidden, notFound, validationError, type AppError } from "@/platform/errors";
import { cancelQueuedJob, defineJob, enqueue, moveQueuedJob } from "@/platform/jobs";
import { entryEditorPath } from "./admin-paths";
import { refOf, summaryOf, titleForLog, type EntrySummary } from "./entry.service";
import { stateOf, transition } from "./lifecycle";
import { NEWER_SAVE } from "./messages";
import { canPublishEntry, canSeeEntry, roleMayPublish } from "./policies";
import { makeLive, prepareForPublish, revisionValues, snapshotOfDraft, type Snapshot } from "./publishing.service";
import {
  findDraft, findEntry, findEntryOfOrganization, fullRevision, holdersOf, insertRevision, latestScheduledRevision, memberRole, nextRevisionNumber, siteFacts,
  siteLinkFacts, termsOfSite, updateEntry, type EntryRow,
} from "./repository";
import type { SiteScope } from "./scope";
import { parseInput, versionSchema } from "./validation";
import { formatInZone, zonedToUtc } from "./zoned-time";

/**
 * Scheduled publishing (M7-2; plan §9 "Schedule"; cms-architecture §16.2, D-16; ADR 0025).
 *
 *   schedule     a draft, checked as for publishing, is frozen as a `scheduled` revision; the entry becomes `scheduled`
 *                at an instant (typed in the site's time zone, stored in UTC); a job `entry.publish_scheduled` is
 *                queued for that instant (`dedupe_key = entry:{id}`). The draft stays editable: what is published is
 *                the frozen revision, never what is typed after.
 *   reschedule   the same revision, another instant: the queued job is moved.
 *   cancel       back to a draft; the queued job is canceled.
 *   the job      at its time, in its organization's tenant transaction, as Forge's system actor: the entry is locked
 *                and checked again (still scheduled, for this revision and this instant; whoever scheduled it may still
 *                publish it; the revision still valid where the site is now), then published through the same
 *                projection as Publish (`makeLive`), recorded as `entry.published` by the system, and flushed with
 *                `revalidateTag(…, { expire: 0 })`.
 *
 * Failures. A transient one (the database, the network) is thrown: the job is retried with the queue's backoff. A
 * permanent one (the address is taken, the parent is in the trash, the scheduler may no longer publish, the revision
 * is no longer valid) is not retried: the entry becomes a draft again with the reason (`schedule_failure`), recorded as
 * `entry.schedule_failed` by the system, and the person who scheduled it gets an email; the editor and the overview
 * say so. After the last attempt of a transient failure the same happens, if the database lets it.
 */

/** At least this far ahead: a schedule is for later, never a disguised "publish now". */
export const SCHEDULE_LEAD_MS = 60_000;
/** At most this far ahead. */
export const SCHEDULE_HORIZON_DAYS = 730;
export const BEING_PUBLISHED = "It is being published right now. Reload the page in a moment.";
const NO_LONGER_ALLOWED = "The person who scheduled it can no longer publish it. Someone who can publishes or schedules it again.";
const TECHNICAL = "Forge could not reach its database or storage in time, after several tries.";

const jobKey = (entryId: string) => `entry:${entryId}`;
const visible = (ctx: SiteContext, entry: EntryRow) => canSeeEntry(ctx, refOf(entry));

/** A wall-clock time typed in the site's zone → the instant, or a field error that says what is wrong with it. */
export function runAtFrom(value: unknown, timeZone: string, now: Date): Date {
  const parsed = zonedToUtc(value, timeZone);
  if (!parsed.ok) {
    const message =
      parsed.reason === "nonexistent"
        ? `That time does not exist in ${timeZone}: the clocks skip it. Choose another.`
        : parsed.reason === "ambiguous"
          ? `That time happens twice in ${timeZone}: the clocks go back over it. Choose another.`
          : "Enter a date and a time.";
    throw validationError({ runAt: [message] });
  }
  if (parsed.at.getTime() < now.getTime() + SCHEDULE_LEAD_MS) throw validationError({ runAt: ["Choose a time at least a minute from now. To publish now, use Publish."] });
  if (parsed.at.getTime() > now.getTime() + SCHEDULE_HORIZON_DAYS * 86_400_000) throw validationError({ runAt: ["Choose a time within the next two years."] });
  return parsed.at;
}

export type Scheduled = { entry: EntrySummary; changed: boolean; runAt: Date; events: CacheEvent[] };

/** Puts the job for this schedule in the queue: moves the one already queued, or queues one. Refused while one is running. */
async function queuePublish(tx: TenantTx, entryId: string, revisionId: string, runAt: Date): Promise<void> {
  const payload = { entryId, revisionId, runAt: runAt.toISOString() };
  const moved = await moveQueuedJob(tx, publishScheduled, jobKey(entryId), payload, runAt);
  if (moved === "running") throw conflict(BEING_PUBLISHED);
  if (moved === "none") {
    const queued = await enqueue(tx, publishScheduled, payload, { runAt, dedupeKey: jobKey(entryId) });
    if (queued.deduplicated) throw conflict(BEING_PUBLISHED);
  }
}

/** Schedules a draft: checked as for publishing, frozen as a `scheduled` revision, published by the job at `runAt`. */
export async function scheduleEntry(ctx: SiteContext, entryId: string, input: { runAt: unknown; version: unknown }): Promise<Scheduled> {
  const expected = parseInput(versionSchema, input.version);
  return inTenant(ctx, async (tx) => {
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
    if (!entry || !visible(ctx, entry)) throw notFound();
    if (!canPublishEntry(ctx, refOf(entry))) throw forbidden();
    const draft = await findDraft(tx, ctx.org.id, ctx.site.id, entry.id, { lock: true });
    if (!draft) throw notFound();
    const step = transition(stateOf(entry), "schedule");
    if (!step.ok) throw conflict(step.reason);
    if (draft.version !== expected) throw conflict(NEWER_SAVE);
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    if (!site) throw notFound();
    const runAt = runAtFrom(input.runAt, site.timeZone, new Date());

    // Checked now as it would be published now; checked again at its time, when the site may have changed.
    const snapshot = snapshotOfDraft(draft);
    const prepared = await prepareForPublish(tx, ctx, entry, snapshot);
    const holder = (await holdersOf(tx, ctx.org.id, ctx.site.id, entry.locale, [prepared.path])).find((row) => row.id !== entry.id);
    if (holder) throw conflict(`The address ${prepared.path} is already used by “${titleForLog(holder.title)}”. Change the slug, then schedule it.`);

    const number = await nextRevisionNumber(tx, ctx.org.id, ctx.site.id, entry.id);
    const revision = await insertRevision(tx, revisionValues(ctx, entry, prepared, snapshot, number, "scheduled", ctx.actor.userId));
    await updateEntry(tx, ctx.org.id, ctx.site.id, entry.id, { status: "scheduled", scheduledAt: runAt, scheduleFailure: null, scheduleFailedAt: null, updatedBy: ctx.actor.userId });
    await queuePublish(tx, entry.id, revision.id, runAt);
    await record(
      tx,
      {
        action: "entry.scheduled", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: { type: entry.type, title: titleForLog(snapshot.title), path: prepared.path, runAt: runAt.toISOString() },
      },
      ctx,
    );
    // Nothing public changes until the job publishes it.
    return { entry: { ...summaryOf(entry), status: "scheduled" }, changed: true, runAt, events: [] };
  });
}

/** Moves a schedule to another time: the same frozen revision. To publish newer changes, cancel and schedule again. */
export async function rescheduleEntry(ctx: SiteContext, entryId: string, input: { runAt: unknown }): Promise<Scheduled> {
  return inTenant(ctx, async (tx) => {
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
    if (!entry || !visible(ctx, entry)) throw notFound();
    if (!canPublishEntry(ctx, refOf(entry))) throw forbidden();
    const step = transition(stateOf(entry), "reschedule");
    if (!step.ok) throw conflict(step.reason);
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    const revision = await latestScheduledRevision(tx, ctx.org.id, ctx.site.id, entry.id);
    if (!site || !revision || !entry.scheduledAt) throw notFound();
    const runAt = runAtFrom(input.runAt, site.timeZone, new Date());
    const previous = entry.scheduledAt;
    if (previous.getTime() === runAt.getTime()) return { entry: summaryOf(entry), changed: false, runAt, events: [] };

    await updateEntry(tx, ctx.org.id, ctx.site.id, entry.id, { scheduledAt: runAt, updatedBy: ctx.actor.userId });
    await queuePublish(tx, entry.id, revision.id, runAt);
    await record(
      tx,
      {
        action: "entry.scheduled", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: { type: entry.type, title: titleForLog(revision.title), path: entry.path, runAt: runAt.toISOString(), previousRunAt: previous.toISOString() },
      },
      ctx,
    );
    return { entry: summaryOf(entry), changed: true, runAt, events: [] };
  });
}

/** Cancels a schedule: back to a draft (the frozen revision stays in the history). A draft is left as it is. */
export async function cancelSchedule(ctx: SiteContext, entryId: string): Promise<{ entry: EntrySummary; changed: boolean; events: CacheEvent[] }> {
  return inTenant(ctx, async (tx) => {
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
    if (!entry || !visible(ctx, entry)) throw notFound();
    if (!canPublishEntry(ctx, refOf(entry))) throw forbidden();
    if (entry.status === "draft") return { entry: summaryOf(entry), changed: false, events: [] };
    const step = transition(stateOf(entry), "cancel_schedule");
    if (!step.ok) throw conflict(step.reason);
    const revision = await latestScheduledRevision(tx, ctx.org.id, ctx.site.id, entry.id);
    await updateEntry(tx, ctx.org.id, ctx.site.id, entry.id, { status: "draft", scheduledAt: null, updatedBy: ctx.actor.userId });
    // A job already running for it finds a draft once it has the entry's lock, and publishes nothing.
    await cancelQueuedJob(tx, publishScheduled, jobKey(entry.id));
    await record(
      tx,
      {
        action: "entry.schedule_canceled", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: { type: entry.type, title: titleForLog(revision?.title ?? entry.title), path: entry.path, runAt: entry.scheduledAt!.toISOString() },
      },
      ctx,
    );
    return { entry: { ...summaryOf(entry), status: "draft" }, changed: true, events: [] };
  });
}

// ── The job ──────────────────────────────────────────────────────────────────

export type DuePayload = { entryId: string; revisionId: string; runAt: string };
export type DueOutcome = { kind: "published" | "already"; events: CacheEvent[] } | { kind: "skipped"; why: string };

type RevisionRow = NonNullable<Awaited<ReturnType<typeof fullRevision>>>;
const snapshotOfRevision = (revision: RevisionRow, termIds: readonly string[]): Snapshot => ({
  title: revision.title, slug: revision.slug, excerpt: revision.excerpt, featuredMediaId: revision.featuredMediaId, template: revision.template, content: revision.content,
  fields: revision.fields, seo: revision.seo, termIds, sourceDraftVersion: revision.sourceDraftVersion,
});

/**
 * Publishes a due schedule, in the job's organization's tenant transaction (no user in it). Idempotent: a schedule
 * that was canceled, moved to another time, replaced, or already published is left alone (an "already" outcome
 * flushes the cache again, for a run that published and then failed before flushing). A permanent refusal is thrown
 * as the `AppError` it is; the transaction then writes nothing.
 */
export async function publishDue(tx: TenantTx, orgId: string, payload: DuePayload): Promise<DueOutcome> {
  const entry = await findEntryOfOrganization(tx, orgId, payload.entryId);
  if (!entry) return { kind: "skipped", why: "gone" };
  if (entry.status === "published" && entry.publishedRevisionId === payload.revisionId) {
    return { kind: "already", events: [{ type: "entry.published", siteId: entry.siteId, entryId: entry.id, contentType: entry.type }] };
  }
  if (entry.status !== "scheduled" || entry.scheduledAt?.getTime() !== Date.parse(payload.runAt)) return { kind: "skipped", why: "canceled or moved" };
  const step = transition(stateOf(entry), "publish_scheduled");
  const revision = await fullRevision(tx, orgId, entry.siteId, entry.id, payload.revisionId);
  if (!step.ok || !revision || revision.kind !== "scheduled") return { kind: "skipped", why: "not this schedule" };

  // Who scheduled it must still be allowed to publish it: the job publishes in their stead, never with rights of its own.
  const scheduler = revision.createdBy;
  const role = scheduler ? await memberRole(tx, orgId, scheduler) : null;
  if (!scheduler || !role || !roleMayPublish(role, scheduler, refOf(entry))) throw forbidden(NO_LONGER_ALLOWED);

  // Terms deleted since it was scheduled are left out, as a term's deletion takes it off live posts; those that remain
  // are this site's (checked again in `prepareForPublish`).
  const scope: SiteScope = { org: { id: orgId }, site: { id: entry.siteId } };
  const remaining = new Set((await termsOfSite(tx, orgId, entry.siteId, revision.termIds)).map((term) => term.id));
  const snapshot = snapshotOfRevision(revision, revision.termIds.filter((id) => remaining.has(id)));
  const prepared = await prepareForPublish(tx, scope, entry, snapshot);
  const { path, events } = await makeLive(tx, scope, entry, prepared, snapshot, revision, { userId: null, publishedAt: entry.scheduledAt! });
  await recordSystem(
    tx,
    {
      action: "entry.published", resourceType: "entry", resourceId: entry.id, siteId: entry.siteId,
      metadata: { type: prepared.definition.key, title: titleForLog(snapshot.title), path, revision: revision.number, scheduled: true },
    },
    "entry.publish_scheduled",
  );
  return { kind: "published", events };
}

/** The words a permanent refusal is shown in: its message, or the first field error. Never the content. */
function reasonOf(error: AppError): string {
  const field = error.fieldErrors ? Object.values(error.fieldErrors).flat()[0] : undefined;
  return (field ?? error.message ?? "It could not be published.").slice(0, 500);
}

/**
 * The schedule could not happen: back to a draft with the reason, recorded by the system, and an email queued to the
 * person who scheduled it. Only if it is still this schedule (a cancel or a move in between wins). No cache event:
 * nothing public changed.
 */
export async function failDue(tx: TenantTx, orgId: string, payload: DuePayload, reason: string): Promise<boolean> {
  const entry = await findEntryOfOrganization(tx, orgId, payload.entryId);
  if (!entry || entry.status !== "scheduled" || entry.scheduledAt?.getTime() !== Date.parse(payload.runAt)) return false;
  const revision = await fullRevision(tx, orgId, entry.siteId, entry.id, payload.revisionId);
  await updateEntry(tx, orgId, entry.siteId, entry.id, { status: "draft", scheduledAt: null, scheduleFailure: reason, scheduleFailedAt: new Date(), updatedBy: null });
  const title = titleForLog(revision?.title ?? entry.title);
  await recordSystem(
    tx,
    {
      action: "entry.schedule_failed", resourceType: "entry", resourceId: entry.id, siteId: entry.siteId,
      metadata: { type: entry.type, title, path: entry.path, runAt: payload.runAt, reason },
    },
    "entry.publish_scheduled",
  );
  const site = await siteFacts(tx, orgId, entry.siteId);
  const links = await siteLinkFacts(tx, orgId, entry.siteId);
  if (revision?.createdBy && site && links) {
    await queueEmail(tx, {
      template: "scheduled-publish-failed",
      userId: revision.createdBy,
      url: `${env("core").APP_ORIGIN.replace(/\/$/, "")}${entryEditorPath(links.orgSlug, links.siteSlug, entry.type, entry.id)}`,
      title,
      siteName: links.siteName,
      when: formatInZone(new Date(payload.runAt), site.timeZone),
      reason,
    });
  }
  return true;
}

/** Refusals that retrying cannot change: the entry, the site or the scheduler's rights say no. */
const PERMANENT = new Set(["Validation", "Conflict", "Forbidden", "NotFound"]);

/**
 * `entry.publish_scheduled` (tenant). Run by the queue's runner once its time has come (the runner's clock decides
 * when; the handler checks that it is still this schedule, not the time again). Delivery is at least once: the entry
 * lock and the checks make a second run a no-op.
 */
export const publishScheduled = defineJob({
  type: "entry.publish_scheduled",
  scope: "tenant",
  payload: z.object({ entryId: z.uuid(), revisionId: z.uuid(), runAt: z.iso.datetime() }),
  maxAttempts: 5,
  run: async (payload, ctx) => {
    const orgId = ctx.orgId!;
    let outcome: DueOutcome;
    try {
      outcome = await ctx.withTenant((tx) => publishDue(tx, orgId, payload));
    } catch (error) {
      const refusal = asAppError(error);
      if (refusal && PERMANENT.has(refusal.kind)) {
        const reason = reasonOf(refusal);
        const failed = await ctx.withTenant((tx) => failDue(tx, orgId, payload, reason));
        ctx.log.warn("scheduled publish refused; the entry is a draft again", { entryId: payload.entryId, kind: refusal.kind, failed });
        return;
      }
      if (ctx.job.attempt >= ctx.job.maxAttempts) {
        // The last attempt: say so on the entry, if the database lets us. The job is still marked dead below.
        try {
          await ctx.withTenant((tx) => failDue(tx, orgId, payload, TECHNICAL));
        } catch (inner) {
          ctx.log.error("scheduled publish: could not record the failure on the entry", { entryId: payload.entryId, err: inner });
        }
      }
      throw error;
    }
    if (outcome.kind === "skipped") {
      ctx.log.info("scheduled publish skipped", { entryId: payload.entryId, why: outcome.why });
      return;
    }
    // A publish the queue did is flushed with `revalidateTag(tag, { expire: 0 })` (plan §9): visitors get it on their next request.
    invalidate(outcome.events, "background");
    ctx.log.info("scheduled publish done", { entryId: payload.entryId, outcome: outcome.kind });
  },
});
