import "server-only";
import { z } from "zod";
import { purgeTrashedMedia } from "@/modules/media";
import { withPlatform, withTenant } from "@/platform/db";
import { defineJob } from "@/platform/jobs";
import { logger, type Logger } from "@/platform/observability";
import { ENTRY_TRASH_DAYS } from "./lifecycle";
import { childrenOf, deleteTrashed, lockSiteSettings, organizationsWithPurgeableEntries, purgeCandidates, sitesWithPurgeableEntries } from "./repository";

/**
 * `trash.purge` (daily; plan §9, §16): what has been in the trash for 30 days is deleted for good. Entries since M7-1,
 * then media as M6-3 made it (`purgeTrashedMedia`, unchanged): one job, one schedule, one retention.
 *
 * Entries, in each organization that has any (a lookup returning organization ids only, migration 0013), in that
 * organization's own tenant context, site by site, in batches. Each batch is one transaction:
 *   1. the site's settings row is locked, as every change to a site's tree locks it (a restore, a trash, a move, a
 *      homepage change): a restore that began first finishes first, and one that comes later finds nothing to restore;
 *   2. the oldest entries in the trash since before the cutoff are locked;
 *   3. an entry is kept back if anything below it is not being deleted with it: a page in the trash never has live
 *      pages below it, so this only defers a page whose trashed children fall in a later batch (or keeps one that a
 *      broken invariant would orphan, reported). The site's Home page is never deleted;
 *   4. the rest are deleted, still in the trash and still past the cutoff (checked in the DELETE itself). Their drafts,
 *      revisions and published term links go with them; media they used, and other entries, do not.
 * A batch that fails rolls back whole and is tried again on the next run: nothing is half-deleted.
 *
 * No audit record, as for media (ADR 0022): no one did this, and the trashing was recorded. The audit writer has no
 * system actor yet (M7-2).
 */

const ORGANIZATIONS_PER_RUN = 500;
const BATCH = 200;
const BUDGET_MS = 30_000;

export type EntryPurgeResult = { organizations: number; purged: number; blocked: number; unfinished: boolean };

/** One batch of one site. `blocked`: entries kept back because something below them would be orphaned, or the Home page. */
async function purgeBatch(orgId: string, siteId: string, before: Date, log: Logger): Promise<{ candidates: number; purged: number; blocked: number }> {
  return withTenant({ orgId }, async (tx) => {
    const settings = await lockSiteSettings(tx, orgId, siteId);
    const candidates = await purgeCandidates(tx, orgId, siteId, before, BATCH);
    if (!candidates.length) return { candidates: 0, purged: 0, blocked: 0 };
    const going = new Set(candidates.map((row) => row.id));
    const children = await childrenOf(tx, orgId, siteId, [...going], before);
    // Keep back anything with a child that stays, until nothing changes: a page goes only with everything below it. A
    // child that is due but not in this batch only defers it to the next one; a child that is live, or not due, would
    // be orphaned (a broken invariant: a page in the trash has only pages in the trash below it, trashed with it or
    // before), so it is kept back and reported.
    let blocked = 0;
    for (let changed = true; changed; ) {
      changed = false;
      for (const child of children) {
        if (going.has(child.parentId) && !going.has(child.id)) {
          going.delete(child.parentId);
          changed = true;
          if (!child.trashed || !child.due) {
            blocked++;
            log.warn("trash.purge kept back a page: something below it is not due", { siteId, entryId: child.parentId, childId: child.id, childTrashed: child.trashed });
          }
        }
      }
    }
    if (settings?.homepageEntryId && going.delete(settings.homepageEntryId)) {
      blocked++;
      log.warn("trash.purge kept back the site's home page", { siteId, entryId: settings.homepageEntryId });
    }
    const purged = await deleteTrashed(tx, orgId, siteId, [...going], before);
    return { candidates: candidates.length, purged: purged.length, blocked };
  });
}

export async function purgeTrashedEntries(options: { now?: Date; budgetMs?: number; log?: Logger } = {}): Promise<EntryPurgeResult> {
  const now = options.now ?? new Date();
  const log = options.log ?? logger;
  const deadline = Date.now() + (options.budgetMs ?? BUDGET_MS);
  const before = new Date(now.getTime() - ENTRY_TRASH_DAYS * 24 * 3_600_000);
  const result: EntryPurgeResult = { organizations: 0, purged: 0, blocked: 0, unfinished: false };

  const organizations = await withPlatform((tx) => organizationsWithPurgeableEntries(tx, before, ORGANIZATIONS_PER_RUN));
  for (const orgId of organizations) {
    if (Date.now() > deadline) {
      result.unfinished = true;
      break;
    }
    result.organizations++;
    const sites = await withTenant({ orgId }, (tx) => sitesWithPurgeableEntries(tx, orgId, before));
    for (const siteId of sites) {
      for (;;) {
        const batch = await purgeBatch(orgId, siteId, before, log);
        result.purged += batch.purged;
        result.blocked += batch.blocked;
        // Done with the site when a batch was not full, or deleted nothing (what is left is kept back).
        if (batch.candidates < BATCH || batch.purged === 0) break;
        if (Date.now() > deadline) {
          result.unfinished = true;
          break;
        }
      }
    }
  }
  if (organizations.length === ORGANIZATIONS_PER_RUN) result.unfinished = true;
  return result;
}

/**
 * The daily job: entries, then media. One failing does not stop the other; the job fails afterwards, so the failure is
 * seen, and the next run picks up whatever is still due.
 */
export const trashPurge = defineJob({
  type: "trash.purge",
  scope: "platform",
  payload: z.object({}),
  run: async (_payload, ctx) => {
    const failures: string[] = [];
    try {
      const entries = await purgeTrashedEntries({ log: ctx.log });
      ctx.log.info("trash.purge finished entries", entries);
      if (entries.blocked) failures.push(`${entries.blocked} entry(ies) in the trash were kept back (see the warnings)`);
    } catch (error) {
      ctx.log.error("trash.purge failed on entries", { err: error });
      failures.push("entries failed");
    }
    try {
      const media = await purgeTrashedMedia({ log: ctx.log });
      ctx.log.info("trash.purge finished media", media);
      if (media.kept) failures.push(`the objects of ${media.kept} media item(s) could not be deleted; uploads.cleanup retries them`);
    } catch (error) {
      ctx.log.error("trash.purge failed on media", { err: error });
      failures.push("media failed");
    }
    if (failures.length) throw new Error(`trash.purge: ${failures.join("; ")}`);
  },
});
