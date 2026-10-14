import "server-only";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PlatformTx, TenantTx } from "@/platform/db";
import { sites } from "@/platform/db/schema";
import { mediaAssets, type MediaVariant } from "./schema";

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

const isThis = (organizationId: string, siteId: string, mediaId: string) =>
  and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.siteId, siteId), eq(mediaAssets.id, mediaId));
const heldBy = (token: string) => and(eq(mediaAssets.status, "pending"), eq(mediaAssets.processingToken, token));

/**
 * Takes the hold on a pending upload (M6-2): only one completion processes it at a time. Free, or held by a
 * completion whose hold ran out (it crashed): taken. Returns the row as it is now, or null if someone else holds it
 * or it is no longer pending.
 */
export async function claimUpload(tx: TenantTx, organizationId: string, siteId: string, mediaId: string, token: string, holdSeconds: number): Promise<MediaRow | null> {
  const [row] = await tx
    .update(mediaAssets)
    .set({ processingToken: token, processingUntil: sql`now() + make_interval(secs => ${holdSeconds})`, updatedAt: sql`now()` })
    .where(
      and(
        isThis(organizationId, siteId, mediaId),
        eq(mediaAssets.status, "pending"),
        isNull(mediaAssets.deletedAt),
        or(isNull(mediaAssets.processingUntil), lt(mediaAssets.processingUntil, sql`now()`)),
      ),
    )
    .returning();
  return row ?? null;
}

/** Names on the row every object about to be written (write-ahead), so none can be left untracked. False: the hold is gone. */
export async function recordVariants(tx: TenantTx, organizationId: string, siteId: string, mediaId: string, token: string, variants: MediaVariant[]): Promise<boolean> {
  const rows = await tx
    .update(mediaAssets)
    .set({ variants, updatedAt: sql`now()` })
    .where(and(isThis(organizationId, siteId, mediaId), heldBy(token)))
    .returning({ id: mediaAssets.id });
  return rows.length === 1;
}

/** `pending → ready`, by the completion that holds it: its dimensions, its variants and their bytes. Null: the hold is gone. */
export async function settleReady(
  tx: TenantTx,
  organizationId: string,
  siteId: string,
  mediaId: string,
  token: string,
  values: { width: number | null; height: number | null; variants: MediaVariant[]; variantBytes: number },
): Promise<MediaRow | null> {
  const [row] = await tx
    .update(mediaAssets)
    .set({ ...values, status: "ready", processingToken: null, processingUntil: null, updatedAt: sql`now()` })
    .where(and(isThis(organizationId, siteId, mediaId), heldBy(token)))
    .returning();
  return row ?? null;
}

/** `pending → failed`, by the completion that holds it. From then on it can never become `ready`. Null: the hold is gone. */
export async function settleFailed(tx: TenantTx, organizationId: string, siteId: string, mediaId: string, token: string): Promise<MediaRow | null> {
  const [row] = await tx
    .update(mediaAssets)
    .set({ status: "failed", processingToken: null, processingUntil: null, updatedAt: sql`now()` })
    .where(and(isThis(organizationId, siteId, mediaId), heldBy(token)))
    .returning();
  return row ?? null;
}

/** Lets go of a pending upload after a failure that was not the file's, so completing it again can start at once. */
export async function releaseUpload(tx: TenantTx, organizationId: string, siteId: string, mediaId: string, token: string, options: { variantsDeleted: boolean }): Promise<void> {
  await tx
    .update(mediaAssets)
    .set({ processingToken: null, processingUntil: null, ...(options.variantsDeleted ? { variants: [] } : {}), updatedAt: sql`now()` })
    .where(and(isThis(organizationId, siteId, mediaId), heldBy(token)));
}

// ── /media/{key} ──────────────────────────────────────────────────────────────

export type PublicObject = { organizationId: string; siteId: string; contentType: string };

/**
 * Is `key` a public object of this media item: a variant of a ready, untrashed image, or the file of a ready,
 * untrashed document? A SECURITY DEFINER lookup (migration 0009): the request has no tenant context.
 */
export async function publicMediaObject(tx: PlatformTx, mediaId: string, key: string): Promise<PublicObject | null> {
  const { rows } = await tx.execute<{ organization_id: string; site_id: string; content_type: string }>(
    sql`select organization_id, site_id, content_type from public_media_object(${mediaId}::uuid, ${key})`,
  );
  const row = rows[0];
  return row ? { organizationId: row.organization_id, siteId: row.site_id, contentType: row.content_type } : null;
}

// ── uploads.cleanup ───────────────────────────────────────────────────────────

/** The organizations with an upload not `ready` that was requested before `before` (a SECURITY DEFINER lookup: ids only). */
export async function organizationsWithUnfinishedUploads(tx: PlatformTx, before: Date, limit: number): Promise<string[]> {
  const { rows } = await tx.execute<{ organization_id: string }>(sql`select organization_id from organizations_with_unfinished_uploads(${before.toISOString()}::timestamptz, ${limit})`);
  return rows.map((row) => row.organization_id);
}

/** Not held by a completion now (never held, or its hold ran out): the cleanup never works under a running completion. */
const notHeld = () => or(isNull(mediaAssets.processingUntil), lt(mediaAssets.processingUntil, sql`now()`));

/** Uploads of this organization requested before `before` and never completed become `failed`: no completion can make them `ready` now. */
export async function expirePendingUploads(tx: TenantTx, organizationId: string, before: Date): Promise<number> {
  const rows = await tx
    .update(mediaAssets)
    .set({ status: "failed", processingToken: null, processingUntil: null, updatedAt: sql`now()` })
    .where(and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.status, "pending"), lt(mediaAssets.createdAt, before), notHeld()))
    .returning({ id: mediaAssets.id });
  return rows.length;
}

export type FailedUpload = Pick<MediaRow, "id" | "organizationId" | "siteId" | "storageKey" | "variants">;

/** Every object a media item may have in storage: its original and each variant on its row. */
export const objectKeysOf = (row: Pick<MediaRow, "storageKey" | "variants">): string[] => [row.storageKey, ...row.variants.map((variant) => variant.storageKey)];

/** Failed uploads of this organization requested before `before`, oldest first: their objects and rows are removed. */
export async function failedUploads(tx: TenantTx, organizationId: string, before: Date, limit: number): Promise<FailedUpload[]> {
  return tx
    .select({ id: mediaAssets.id, organizationId: mediaAssets.organizationId, siteId: mediaAssets.siteId, storageKey: mediaAssets.storageKey, variants: mediaAssets.variants })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.status, "failed"), lt(mediaAssets.createdAt, before), notHeld()))
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
