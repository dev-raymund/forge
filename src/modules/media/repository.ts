import "server-only";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { PlatformTx, TenantTx } from "@/platform/db";
import { sites } from "@/platform/db/schema";
import { mediaAssets } from "./schema";

/**
 * The media module's queries (M6-1). Every one names the organization AND the
 * site: RLS keeps organizations apart, but two sites of one organization share
 * it, so the site is this code's to check.
 */

export type MediaRow = typeof mediaAssets.$inferSelect;
export type NewMediaRow = typeof mediaAssets.$inferInsert;

/** Is the site there (not deleted)? Locks nothing: the organization's lock (`assertLimit`) serialises uploads. */
export async function siteExists(tx: TenantTx, organizationId: string, siteId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.organizationId, organizationId), eq(sites.id, siteId), isNull(sites.deletedAt)));
  return !!row;
}

export async function insertMedia(tx: TenantTx, rows: NewMediaRow[]): Promise<MediaRow[]> {
  return tx.insert(mediaAssets).values(rows).returning();
}

/** One media item of this site, trashed ones included (the caller decides). */
export async function findMedia(tx: TenantTx, organizationId: string, siteId: string, mediaId: string): Promise<MediaRow | null> {
  const [row] = await tx
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.siteId, siteId), eq(mediaAssets.id, mediaId)));
  return row ?? null;
}

/**
 * `pending` → `ready` or `failed`, only from `pending`: whatever got there first (a concurrent completion, the
 * cleanup) wins, and this returns null. The caller then reads what the row became.
 */
export async function settleUpload(tx: TenantTx, organizationId: string, siteId: string, mediaId: string, status: "ready" | "failed"): Promise<MediaRow | null> {
  const [row] = await tx
    .update(mediaAssets)
    .set({ status, updatedAt: sql`now()` })
    .where(and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.siteId, siteId), eq(mediaAssets.id, mediaId), eq(mediaAssets.status, "pending")))
    .returning();
  return row ?? null;
}

// ── uploads.cleanup ───────────────────────────────────────────────────────────

/** The organizations with an upload not `ready` that was requested before `before` (a SECURITY DEFINER lookup: ids only). */
export async function organizationsWithUnfinishedUploads(tx: PlatformTx, before: Date, limit: number): Promise<string[]> {
  const { rows } = await tx.execute<{ organization_id: string }>(sql`select organization_id from organizations_with_unfinished_uploads(${before.toISOString()}::timestamptz, ${limit})`);
  return rows.map((row) => row.organization_id);
}

/** Uploads of this organization requested before `before` and never completed become `failed`: no completion can make them `ready` now. */
export async function expirePendingUploads(tx: TenantTx, organizationId: string, before: Date): Promise<number> {
  const rows = await tx
    .update(mediaAssets)
    .set({ status: "failed", updatedAt: sql`now()` })
    .where(and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.status, "pending"), lt(mediaAssets.createdAt, before)))
    .returning({ id: mediaAssets.id });
  return rows.length;
}

export type FailedUpload = Pick<MediaRow, "id" | "organizationId" | "siteId" | "storageKey">;

/** Failed uploads of this organization requested before `before`, oldest first: their objects and rows are removed. */
export async function failedUploads(tx: TenantTx, organizationId: string, before: Date, limit: number): Promise<FailedUpload[]> {
  return tx
    .select({ id: mediaAssets.id, organizationId: mediaAssets.organizationId, siteId: mediaAssets.siteId, storageKey: mediaAssets.storageKey })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.status, "failed"), lt(mediaAssets.createdAt, before)))
    .orderBy(asc(mediaAssets.createdAt))
    .limit(limit);
}

/** Removes these rows if they are still `failed`. */
export async function deleteFailedUploads(tx: TenantTx, organizationId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await tx
    .delete(mediaAssets)
    .where(and(eq(mediaAssets.organizationId, organizationId), inArray(mediaAssets.id, ids), eq(mediaAssets.status, "failed")))
    .returning({ id: mediaAssets.id });
  return rows.length;
}
