import "server-only";
import { z } from "zod";
import { withPlatform, withTenant } from "@/platform/db";
import { defineJob } from "@/platform/jobs";
import { logger, type Logger } from "@/platform/observability";
import { storageFor } from "@/platform/storage";
import { UNFINISHED_UPLOAD_HOURS } from "./policy";
import { deleteFailedUploads, expirePendingUploads, failedUploads, organizationsWithUnfinishedUploads, type FailedUpload } from "./repository";

/**
 * `uploads.cleanup` (daily; plan §8, §16): uploads requested more than 24 hours ago that were never completed, and
 * uploads that were refused, are removed with their objects. Their bytes stop counting towards the storage limit
 * as soon as they are `failed`.
 *
 * In each organization that has any (a lookup that returns organization ids only), inside that organization's own
 * tenant context:
 *   1. its `pending` uploads past the cutoff become `failed`, in one statement. From then on no `completeUpload` can
 *      make them `ready` (it only settles `pending` rows), so an object is never deleted from under a ready row;
 *   2. the objects of its `failed` uploads past the cutoff are deleted, each through the storage scoped to the row's
 *      own organization and site;
 *   3. the rows whose objects are gone are deleted. A row whose object could not be deleted is kept for the next run.
 *
 * Idempotent: deleting a missing object is not an error, and a second run finds nothing. A `ready` upload is never
 * touched. Bounded: it stops starting organizations when its time is up, and the next run carries on.
 */

const ORGANIZATIONS_PER_RUN = 500;
const BATCH = 100;
const PARALLEL_DELETES = 8;
const BUDGET_MS = 30_000;

export type UploadsCleanupResult = { organizations: number; expired: number; removed: number; kept: number; unfinished: boolean };

async function deleteObjects(uploads: FailedUpload[], log: Logger): Promise<string[]> {
  const deleted: string[] = [];
  for (let i = 0; i < uploads.length; i += PARALLEL_DELETES) {
    await Promise.all(
      uploads.slice(i, i + PARALLEL_DELETES).map(async (upload) => {
        try {
          await storageFor({ organizationId: upload.organizationId, siteId: upload.siteId }).delete(upload.storageKey);
          deleted.push(upload.id);
        } catch (error) {
          log.warn("uploads.cleanup could not delete an object; its row is kept for the next run", { mediaId: upload.id, err: error });
        }
      }),
    );
  }
  return deleted;
}

export async function cleanUpUploads(options: { now?: Date; budgetMs?: number; log?: Logger } = {}): Promise<UploadsCleanupResult> {
  const now = options.now ?? new Date();
  const log = options.log ?? logger;
  const deadline = Date.now() + (options.budgetMs ?? BUDGET_MS);
  const before = new Date(now.getTime() - UNFINISHED_UPLOAD_HOURS * 3_600_000);
  const result: UploadsCleanupResult = { organizations: 0, expired: 0, removed: 0, kept: 0, unfinished: false };

  const organizations = await withPlatform((tx) => organizationsWithUnfinishedUploads(tx, before, ORGANIZATIONS_PER_RUN));
  for (const orgId of organizations) {
    if (Date.now() > deadline) {
      result.unfinished = true;
      break;
    }
    result.organizations++;
    result.expired += await withTenant({ orgId }, (tx) => expirePendingUploads(tx, orgId, before));
    for (;;) {
      const batch = await withTenant({ orgId }, (tx) => failedUploads(tx, orgId, before, BATCH));
      if (!batch.length) break;
      const gone = await deleteObjects(batch, log);
      result.removed += await withTenant({ orgId }, (tx) => deleteFailedUploads(tx, orgId, gone));
      result.kept += batch.length - gone.length;
      // A full batch with nothing undeletable may have more behind it; otherwise the next run retries what was kept.
      if (gone.length < batch.length || batch.length < BATCH || Date.now() > deadline) break;
    }
  }
  if (organizations.length === ORGANIZATIONS_PER_RUN) result.unfinished = true;
  return result;
}

export const uploadsCleanup = defineJob({
  type: "uploads.cleanup",
  scope: "platform",
  payload: z.object({}),
  run: async (_payload, ctx) => {
    const result = await cleanUpUploads({ log: ctx.log });
    ctx.log.info("uploads.cleanup finished", result);
    // Storage refused some deletes: say so (the job is retried), rather than report a clean run.
    if (result.kept) throw new Error(`uploads.cleanup kept ${result.kept} failed upload(s) whose objects could not be deleted`);
  },
});
