import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { PlatformTx, TenantTx } from "@/platform/db";
import { sites } from "@/platform/db/schema";
import { mediaAssets, mediaFolders, type MediaVariant } from "./schema";

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

// ── The library (M6-3) ────────────────────────────────────────────────────────

export type FolderRow = typeof mediaFolders.$inferSelect;

/** One folder of this site. `lock`: `share` while something is put in it, `update` while it is renamed or deleted. */
export async function findFolder(tx: TenantTx, organizationId: string, siteId: string, folderId: string, lock?: "share" | "update"): Promise<FolderRow | null> {
  const query = tx
    .select()
    .from(mediaFolders)
    .where(and(eq(mediaFolders.organizationId, organizationId), eq(mediaFolders.siteId, siteId), eq(mediaFolders.id, folderId)));
  const [row] = lock === "share" ? await query.for("share") : lock === "update" ? await query.for("update") : await query;
  return row ?? null;
}

/** The site's folders (one level in V1), by name, each with how many of its files are in the library (ready, untrashed). */
export async function foldersOf(tx: TenantTx, organizationId: string, siteId: string): Promise<(FolderRow & { files: number })[]> {
  const rows = await tx
    .select({
      folder: mediaFolders,
      // Spelled out: in a one-table select Drizzle leaves column names unqualified, which the subquery would read as its own.
      files: sql<number>`(select count(*)::int from media_assets m where m.site_id = media_folders.site_id and m.folder_id = media_folders.id and m.status = 'ready' and m.deleted_at is null)`,
    })
    .from(mediaFolders)
    .where(and(eq(mediaFolders.organizationId, organizationId), eq(mediaFolders.siteId, siteId)))
    .orderBy(sql`lower(${mediaFolders.name})`, asc(mediaFolders.id));
  return rows.map((row) => ({ ...row.folder, files: row.files }));
}

export const FOLDER_NAME_KEY = "media_folders_site_parent_name_unique";

export async function insertFolder(tx: TenantTx, values: typeof mediaFolders.$inferInsert): Promise<FolderRow> {
  const [row] = await tx.insert(mediaFolders).values(values).returning();
  return row!;
}

export async function renameFolderRow(tx: TenantTx, organizationId: string, siteId: string, folderId: string, name: string): Promise<void> {
  await tx
    .update(mediaFolders)
    .set({ name, updatedAt: sql`now()` })
    .where(and(eq(mediaFolders.organizationId, organizationId), eq(mediaFolders.siteId, siteId), eq(mediaFolders.id, folderId)));
}

/** Files in a folder that keep it from being deleted: any not trashed and not refused (an upload in progress counts). */
export async function filesKeepingFolder(tx: TenantTx, organizationId: string, siteId: string, folderId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.siteId, siteId), eq(mediaAssets.folderId, folderId), isNull(mediaAssets.deletedAt), ne(mediaAssets.status, "failed")));
  return row?.n ?? 0;
}

export async function deleteFolderRow(tx: TenantTx, organizationId: string, siteId: string, folderId: string): Promise<void> {
  await tx.delete(mediaFolders).where(and(eq(mediaFolders.organizationId, organizationId), eq(mediaFolders.siteId, siteId), eq(mediaFolders.id, folderId)));
}

/** Library items of this site by id, locked for a change. Only ready ones: an upload in progress or refused is not in the library. */
export async function lockLibraryItems(tx: TenantTx, organizationId: string, siteId: string, ids: string[]): Promise<MediaRow[]> {
  if (!ids.length) return [];
  return tx
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.siteId, siteId), inArray(mediaAssets.id, ids), eq(mediaAssets.status, "ready")))
    .orderBy(asc(mediaAssets.id))
    .for("update");
}

export async function updateMediaRow(tx: TenantTx, organizationId: string, siteId: string, mediaId: string, values: Partial<Pick<MediaRow, "title" | "altText" | "caption" | "folderId" | "deletedAt">>): Promise<MediaRow> {
  const [row] = await tx
    .update(mediaAssets)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.siteId, siteId), eq(mediaAssets.id, mediaId)))
    .returning();
  return row!;
}

export type LibraryFilter = {
  q?: string;
  kind?: "image" | "document";
  /** A folder's id; null: in no folder ("All media" is no filter at all). */
  folder?: string | null;
  trash: boolean;
  sort: "newest" | "name" | "size";
  limit: number;
  offset: number;
};

/** Escapes `%`, `_` and `\` for ILIKE: the search text is matched as typed. */
const likeText = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The library's items: ready ones of this site, in the trash or not. The search is over title, file name and
 * alternative text together, the expression the trigram index covers (`media_assets_search_trgm_idx`).
 */
export async function libraryItems(tx: TenantTx, organizationId: string, siteId: string, filter: LibraryFilter): Promise<MediaRow[]> {
  const conditions = [
    eq(mediaAssets.organizationId, organizationId),
    eq(mediaAssets.siteId, siteId),
    eq(mediaAssets.status, "ready"),
    filter.trash ? isNotNull(mediaAssets.deletedAt) : isNull(mediaAssets.deletedAt),
  ];
  if (filter.kind) conditions.push(eq(mediaAssets.kind, filter.kind));
  if (filter.folder !== undefined) conditions.push(filter.folder === null ? isNull(mediaAssets.folderId) : eq(mediaAssets.folderId, filter.folder));
  if (filter.q) conditions.push(sql`(${mediaAssets.title} || ' ' || ${mediaAssets.originalFilename} || ' ' || ${mediaAssets.altText}) ilike ${likeText(filter.q)}`);
  const order =
    filter.sort === "name"
      ? [sql`lower(coalesce(nullif(${mediaAssets.title}, ''), ${mediaAssets.originalFilename}))`, asc(mediaAssets.id)]
      : filter.sort === "size"
        ? [sql`(${mediaAssets.sizeBytes} + ${mediaAssets.variantBytes}) desc`, asc(mediaAssets.id)]
        : [sql`${filter.trash ? mediaAssets.deletedAt : mediaAssets.createdAt} desc`, sql`${mediaAssets.id} desc`];
  return tx
    .select()
    .from(mediaAssets)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(filter.limit)
    .offset(filter.offset);
}

// ── trash.purge ───────────────────────────────────────────────────────────────

/** The organizations with media trashed before `before` (a SECURITY DEFINER lookup, migration 0011: ids only). */
export async function organizationsWithPurgeableMedia(tx: PlatformTx, before: Date, limit: number): Promise<string[]> {
  const { rows } = await tx.execute<{ organization_id: string }>(sql`select organization_id from organizations_with_purgeable_media(${before.toISOString()}::timestamptz, ${limit})`);
  return rows.map((row) => row.organization_id);
}

/**
 * Media of this organization trashed before `before` becomes `failed`, in one statement: from then on it cannot be
 * restored (restoring needs `ready`), counts towards nothing, and its objects are deleted. Rows a purge cannot finish
 * stay `failed`, where `uploads.cleanup` deletes their objects again.
 */
export async function claimTrashedMedia(tx: TenantTx, organizationId: string, before: Date, limit: number): Promise<FailedUpload[]> {
  const candidates = tx
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.organizationId, organizationId), eq(mediaAssets.status, "ready"), lt(mediaAssets.deletedAt, before)))
    .orderBy(asc(mediaAssets.deletedAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  return tx
    .update(mediaAssets)
    .set({ status: "failed", updatedAt: sql`now()` })
    .where(and(eq(mediaAssets.organizationId, organizationId), inArray(mediaAssets.id, candidates)))
    .returning({ id: mediaAssets.id, organizationId: mediaAssets.organizationId, siteId: mediaAssets.siteId, storageKey: mediaAssets.storageKey, variants: mediaAssets.variants });
}


// ── M7-1: where an image is used, before it goes to the trash ────────────────

export type UsageRow = { kind: "published" | "draft"; title: string; type: string };

/**
 * The site's pages and posts (not in the trash) that use this media item: as their featured image, or in an image block
 * of their published revision (`published`) or of their draft (`draft`), found by walking the stored document as JSON
 * (any `image` node whose `attrs.mediaId` is it), never by matching text. Revisions other than the published one are
 * history, not use (cms-architecture §13). Read from the content module's tables, as the sites module reads them for
 * its checklist; this site only. And whether it is the site's logo or favicon.
 */
export async function usageOf(tx: TenantTx, organizationId: string, siteId: string, mediaId: string): Promise<{ rows: UsageRow[]; logo: boolean; favicon: boolean }> {
  const path = sql`'$.** ? (@.type == "image" && @.attrs.mediaId == $id)'::jsonpath`;
  const vars = sql`jsonb_build_object('id', ${mediaId}::text)`;
  const { rows } = await tx.execute<{ kind: "published" | "draft"; title: string; type: string }>(sql`
    select 'published' as kind, e.title, e.type
      from entries e
      left join entry_revisions r on r.id = e.published_revision_id and r.entry_id = e.id and r.site_id = e.site_id
     where e.organization_id = ${organizationId} and e.site_id = ${siteId} and e.deleted_at is null and e.status = 'published'
       and (e.featured_media_id = ${mediaId} or coalesce(jsonb_path_exists(r.content, ${path}, ${vars}), false))
    union all
    select 'draft' as kind, coalesce(nullif(d.title, ''), e.title), e.type
      from entry_drafts d
      join entries e on e.id = d.entry_id and e.site_id = d.site_id and e.organization_id = d.organization_id
     where d.organization_id = ${organizationId} and d.site_id = ${siteId} and e.deleted_at is null
       and (d.featured_media_id = ${mediaId} or jsonb_path_exists(d.content, ${path}, ${vars}))`);
  const { rows: settings } = await tx.execute<{ logo: boolean; favicon: boolean }>(sql`
    select coalesce(logo_media_id = ${mediaId}, false) as logo, coalesce(favicon_media_id = ${mediaId}, false) as favicon
      from site_settings where organization_id = ${organizationId} and site_id = ${siteId}`);
  return { rows, logo: settings[0]?.logo ?? false, favicon: settings[0]?.favicon ?? false };
}
