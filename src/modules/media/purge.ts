import "server-only";
import { z } from "zod";
import { withPlatform, withTenant } from "@/platform/db";
import { defineJob } from "@/platform/jobs";
import { logger, type Logger } from "@/platform/observability";
import { storageFor } from "@/platform/storage";
import { claimTrashedMedia, deleteFailedUploads, objectKeysOf, organizationsWithPurgeableMedia, type FailedUpload } from "./repository";

/**
 * `trash.purge` (daily; plan §8, §16; M6-3): media in the trash for 30 days is deleted, its objects with it (the
 * original and every variant on its row). Entries join this job in M7-1.
 *
 * In each organization that has any (a lookup that returns organization ids only, migration 0011), in that
 * organization's own tenant context:
 *   1. a batch of them becomes `failed`, in one statement: from then on none can be restored (restoring needs
 *      `ready`), and they count towards nothing;
 *   2. their objects are deleted, through the storage scoped to each row's own organization and site;
 *   3. the rows whose objects are gone are deleted. A row whose objects could not all be deleted stays `failed`, and
 *      `uploads.cleanup` deletes it later as it deletes a refused upload's.
 *
 * Idempotent and bounded, like `uploads.cleanup`. No audit record: no one did this; the trashing was recorded.
 */

export const TRASH_DAYS = 30;
const ORGANIZATIONS_PER_RUN = 500;
const BATCH = 100;
const PARALLEL_DELETES = 8;
const BUDGET_MS = 30_000;

export type TrashPurgeResult = { organizations: number; purged: number; kept: number; unfinished: boolean };

async function deleteObjects(items: FailedUpload[], log: Logger): Promise<string[]> {
  const deleted: string[] = [];
  for (let i = 0; i < items.length; i += PARALLEL_DELETES) {
    await Promise.all(
      items.slice(i, i + PARALLEL_DELETES).map(async (item) => {
        try {
          const storage = storageFor({ organizationId: item.organizationId, siteId: item.siteId });
          for (const key of objectKeysOf(item)) await storage.delete(key);
          deleted.push(item.id);
        } catch (error) {
          log.warn("trash.purge could not delete an object; its row is kept for uploads.cleanup", { mediaId: item.id, err: error });
        }
      }),
    );
  }
  return deleted;
}

export async function purgeTrashedMedia(options: { now?: Date; budgetMs?: number; log?: Logger } = {}): Promise<TrashPurgeResult> {
  const now = options.now ?? new Date();
  const log = options.log ?? logger;
  const deadline = Date.now() + (options.budgetMs ?? BUDGET_MS);
  const before = new Date(now.getTime() - TRASH_DAYS * 24 * 3_600_000);
  const result: TrashPurgeResult = { organizations: 0, purged: 0, kept: 0, unfinished: false };

  const organizations = await withPlatform((tx) => organizationsWithPurgeableMedia(tx, before, ORGANIZATIONS_PER_RUN));
  for (const orgId of organizations) {
    if (Date.now() > deadline) {
      result.unfinished = true;
      break;
    }
    result.organizations++;
    for (;;) {
      const claimed = await withTenant({ orgId }, (tx) => claimTrashedMedia(tx, orgId, before, BATCH));
      if (!claimed.length) break;
      const gone = await deleteObjects(claimed, log);
      result.purged += await withTenant({ orgId }, (tx) => deleteFailedUploads(tx, orgId, gone));
      result.kept += claimed.length - gone.length;
      if (gone.length < claimed.length || claimed.length < BATCH || Date.now() > deadline) break;
    }
  }
  if (organizations.length === ORGANIZATIONS_PER_RUN) result.unfinished = true;
  return result;
}

export const trashPurge = defineJob({
  type: "trash.purge",
  scope: "platform",
  payload: z.object({}),
  run: async (_payload, ctx) => {
    const result = await purgeTrashedMedia({ log: ctx.log });
    ctx.log.info("trash.purge finished", result);
    if (result.kept) throw new Error(`trash.purge could not delete the objects of ${result.kept} media item(s); uploads.cleanup retries them`);
  },
});
