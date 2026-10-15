import "server-only";
import { z } from "zod";
import { record } from "@/modules/audit";
import { allowanceOf, type Allowance } from "@/modules/billing";
import { can, canActOn, inTenant, listMembers, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { mediaPublicBaseUrl } from "@/platform/config/env";
import { isUniqueViolation, type TenantTx } from "@/platform/db";
import { conflict, forbidden, notFound, validationError } from "@/platform/errors";
import { LIBRARY_PAGE_SIZE, type LibraryQuery } from "./library-query";
import { displayName } from "./policy";
import { isWidthVariant } from "./processing";
import {
  deleteFolderRow, filesKeepingFolder, findFolder, FOLDER_NAME_KEY, foldersOf, insertFolder, libraryItems, lockLibraryItems, renameFolderRow, updateMediaRow,
  type FolderRow, type MediaRow,
} from "./repository";

/**
 * The media library (M6-3; plan §8, §19 `/…/media`; ADR 0022).
 *
 *   see the library             Owner–Author (`media.upload`, or `media.update.any`): every ready file of the site
 *   edit a file's details,      `media.update.own` for one's own uploads (Authors), `.any` for everyone's (Editors up);
 *   move it to a folder         an upload whose uploader's account is gone is nobody's own: only `.any`
 *   trash it, restore it        `media.delete.own` / `.any`, likewise
 *   folders: create, rename,    `media.update.any` (Editors up): folders are the site's, not anyone's own
 *   delete an empty one
 *
 * Every query names the organization AND the site: RLS keeps organizations apart, not two sites of one. Each change
 * is one transaction with its audit record, and returns the cache events it makes true (`media.trashed` and
 * `media.restored` at once, `media.updated` stale-while-revalidate: plan §20).
 */

export const MEDIA_TITLE_MAX = 200;
export const MEDIA_ALT_MAX = 500;
export const MEDIA_CAPTION_MAX = 1000;
export const FOLDER_NAME_MAX = 100;
/** How many files one move may name. */
export const MOVE_MAX = 100;

const owned = (row: Pick<MediaRow, "organizationId" | "uploadedBy">) => ({ organizationId: row.organizationId, ownerId: row.uploadedBy });
export const canSeeLibrary = (ctx: SiteContext) => can(ctx, "media.upload") || can(ctx, "media.update.any");
export const canManageFolders = (ctx: SiteContext) => can(ctx, "media.update.any");
const canEdit = (ctx: SiteContext, row: Pick<MediaRow, "organizationId" | "uploadedBy">) => canActOn(ctx, "media.update", owned(row));
const canTrash = (ctx: SiteContext, row: Pick<MediaRow, "organizationId" | "uploadedBy">) => canActOn(ctx, "media.delete", owned(row));
const assertSees = (ctx: SiteContext) => {
  if (!canSeeLibrary(ctx)) throw forbidden();
};

const urlOf = (key: string) => `${mediaPublicBaseUrl()}/${key}`;
const widest = (row: MediaRow) => [...row.variants].filter((v) => isWidthVariant(v.key)).sort((a, b) => b.width - a.width)[0];

export type LibraryItem = {
  id: string;
  kind: "image" | "document";
  filename: string;
  title: string;
  altText: string;
  caption: string;
  mimeType: string;
  /** What it stores in all: the original and its variants (what counts towards the storage limit). */
  storedBytes: number;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  /** An image's square thumbnail (`thumb` variant). Never the original: `/media` does not serve it. */
  thumbUrl: string | null;
  /** A larger view: an image's widest variant up to 1600, or a document's file. */
  previewUrl: string;
  /** The URL to copy: an image's widest variant, a document's file. */
  url: string;
  folderId: string | null;
  uploadedBy: string;
  createdAt: string;
  deletedAt: string | null;
  canEdit: boolean;
  canTrash: boolean;
};

function itemOf(ctx: SiteContext, row: MediaRow, names: Map<string, string>): LibraryItem {
  const thumb = row.variants.find((v) => v.key === "thumb");
  const largest = widest(row);
  const preview = [...row.variants].filter((v) => isWidthVariant(v.key) && v.width <= 1600).sort((a, b) => b.width - a.width)[0] ?? largest;
  const file = row.kind === "document" ? urlOf(row.storageKey) : null;
  return {
    id: row.id, kind: row.kind, filename: row.originalFilename, title: row.title, altText: row.altText, caption: row.caption, mimeType: row.mimeType,
    storedBytes: row.sizeBytes + row.variantBytes, sizeBytes: row.sizeBytes, width: row.width, height: row.height,
    thumbUrl: thumb ? urlOf(thumb.storageKey) : null,
    previewUrl: file ?? (preview ? urlOf(preview.storageKey) : ""),
    url: file ?? (largest ? urlOf(largest.storageKey) : ""),
    folderId: row.folderId,
    uploadedBy: row.uploadedBy ? (names.get(row.uploadedBy) ?? "A former member") : "A deleted account",
    createdAt: row.createdAt.toISOString(), deletedAt: row.deletedAt?.toISOString() ?? null,
    canEdit: canEdit(ctx, row), canTrash: canTrash(ctx, row),
  };
}

export type LibraryFolder = { id: string; name: string; files: number };
export type Library = { items: LibraryItem[]; hasMore: boolean; folders: LibraryFolder[]; storage: Allowance; canManageFolders: boolean; canUpload: boolean };

/** One page of the library (or the trash) for this query, the site's folders, and the organization's storage. */
export async function listLibrary(ctx: SiteContext, query: LibraryQuery): Promise<Library> {
  assertSees(ctx);
  const members = await listMembers(ctx);
  const names = new Map(members.map((member) => [member.userId, member.name || member.email]));
  return inTenant(ctx, async (tx) => {
    const folders = await foldersOf(tx, ctx.org.id, ctx.site.id);
    // A folder that is not this site's (or no longer exists) is no filter at all: it narrows to nothing it could name.
    const folder = query.folder === "none" ? null : query.folder && folders.some((f) => f.id === query.folder) ? query.folder : undefined;
    const rows = await libraryItems(tx, ctx.org.id, ctx.site.id, {
      q: query.q, kind: query.kind, folder, trash: query.trash, sort: query.sort, limit: LIBRARY_PAGE_SIZE + 1, offset: (query.page - 1) * LIBRARY_PAGE_SIZE,
    });
    return {
      items: rows.slice(0, LIBRARY_PAGE_SIZE).map((row) => itemOf(ctx, row, names)),
      hasMore: rows.length > LIBRARY_PAGE_SIZE,
      folders: folders.map((f) => ({ id: f.id, name: f.name, files: f.files })),
      storage: await allowanceOf(tx, ctx.org.id, "storage"),
      canManageFolders: canManageFolders(ctx),
      canUpload: can(ctx, "media.upload"),
    };
  });
}

// ── A file ────────────────────────────────────────────────────────────────────

const text = (max: number, label: string) => z.string().trim().max(max, `${label} can be at most ${max} characters.`);
const detailsSchema = z.object({ title: text(MEDIA_TITLE_MAX, "A title").optional(), altText: text(MEDIA_ALT_MAX, "Alternative text").optional(), caption: text(MEDIA_CAPTION_MAX, "A caption").optional() });
export type MediaDetailsInput = z.input<typeof detailsSchema>;

/** The one item, locked, of this site and in the library. Anything else (another site's, an upload in progress): not found. */
async function libraryItem(tx: TenantTx, ctx: SiteContext, mediaId: unknown): Promise<MediaRow> {
  if (!z.uuid().safeParse(mediaId).success) throw notFound();
  const [row] = await lockLibraryItems(tx, ctx.org.id, ctx.site.id, [mediaId as string]);
  if (!row) throw notFound();
  return row;
}

const auditOf = (row: MediaRow) => ({ kind: row.kind, filename: row.originalFilename });

export async function updateMediaDetails(ctx: SiteContext, mediaId: unknown, input: MediaDetailsInput): Promise<{ changed: boolean; events: CacheEvent[] }> {
  assertSees(ctx);
  const parsed = detailsSchema.safeParse(input ?? {});
  if (!parsed.success) throw validationError(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), [issue.message]])));
  return inTenant(ctx, async (tx) => {
    const row = await libraryItem(tx, ctx, mediaId);
    if (!canEdit(ctx, row)) throw forbidden("Only its uploader or an editor can change this file.");
    if (row.deletedAt) throw conflict("This file is in the trash. Restore it first.");
    const next: { title?: string; altText?: string; caption?: string } = {};
    const fields: ("title" | "alt" | "caption")[] = [];
    if (parsed.data.title !== undefined && parsed.data.title !== row.title) {
      next.title = parsed.data.title;
      fields.push("title");
    }
    if (parsed.data.altText !== undefined && parsed.data.altText !== row.altText) {
      next.altText = parsed.data.altText;
      fields.push("alt");
    }
    if (parsed.data.caption !== undefined && parsed.data.caption !== row.caption) {
      next.caption = parsed.data.caption;
      fields.push("caption");
    }
    if (!fields.length) return { changed: false, events: [] };
    await updateMediaRow(tx, ctx.org.id, ctx.site.id, row.id, next);
    await record(tx, { action: "media.updated", resourceType: "media", resourceId: row.id, siteId: ctx.site.id, metadata: { ...auditOf(row), fields } }, ctx);
    return { changed: true, events: [{ type: "media.updated", mediaId: row.id, siteId: ctx.site.id }] };
  });
}

/** Puts these files in a folder of this site, or in none (`null`). All or nothing: each must be one the member may change. */
export async function moveMedia(ctx: SiteContext, mediaIds: unknown, folderId: unknown): Promise<{ moved: number }> {
  assertSees(ctx);
  const ids = z.array(z.uuid()).min(1).max(MOVE_MAX).safeParse(mediaIds);
  if (!ids.success) throw validationError({ media: [`Choose between 1 and ${MOVE_MAX} files.`] });
  if (folderId !== null && !z.uuid().safeParse(folderId).success) throw validationError({ folderId: ["Choose a folder of this site."] });
  const unique = [...new Set(ids.data)];
  return inTenant(ctx, async (tx) => {
    // The folder first (shared: it cannot be deleted meanwhile), then the files.
    const folder = folderId === null ? null : await findFolder(tx, ctx.org.id, ctx.site.id, folderId as string, "share");
    if (folderId !== null && !folder) throw validationError({ folderId: ["Choose a folder of this site."] });
    const rows = await lockLibraryItems(tx, ctx.org.id, ctx.site.id, unique);
    if (rows.length !== unique.length || rows.some((row) => row.deletedAt)) throw notFound();
    if (rows.some((row) => !canEdit(ctx, row))) throw forbidden("Only their uploader or an editor can move some of these files.");
    const folders = new Map((await foldersOf(tx, ctx.org.id, ctx.site.id)).map((f) => [f.id, f.name]));
    let moved = 0;
    for (const row of rows) {
      if (row.folderId === (folder?.id ?? null)) continue;
      await updateMediaRow(tx, ctx.org.id, ctx.site.id, row.id, { folderId: folder?.id ?? null });
      const previous = row.folderId ? folders.get(row.folderId) : undefined;
      await record(
        tx,
        { action: "media.moved", resourceType: "media", resourceId: row.id, siteId: ctx.site.id, metadata: { ...auditOf(row), ...(folder ? { folderName: folder.name } : {}), ...(previous ? { previousFolderName: previous } : {}) } },
        ctx,
      );
      moved++;
    }
    return { moved };
  });
}

/** To the trash: no longer in the library, no longer served, not usable in content; restorable for 30 days (`trash.purge`). */
export async function trashMedia(ctx: SiteContext, mediaId: unknown): Promise<{ events: CacheEvent[] }> {
  assertSees(ctx);
  return inTenant(ctx, async (tx) => {
    const row = await libraryItem(tx, ctx, mediaId);
    if (!canTrash(ctx, row)) throw forbidden("Only its uploader or an editor can trash this file.");
    if (row.deletedAt) return { events: [] }; // already there
    await updateMediaRow(tx, ctx.org.id, ctx.site.id, row.id, { deletedAt: new Date() });
    await record(tx, { action: "media.trashed", resourceType: "media", resourceId: row.id, siteId: ctx.site.id, metadata: auditOf(row) }, ctx);
    return { events: [{ type: "media.trashed", mediaId: row.id, siteId: ctx.site.id }] };
  });
}

/** Back from the trash, into its folder if that still exists (a deleted folder's files are in no folder). */
export async function restoreMedia(ctx: SiteContext, mediaId: unknown): Promise<{ events: CacheEvent[] }> {
  assertSees(ctx);
  return inTenant(ctx, async (tx) => {
    // `ready` only: once the purge has claimed it, it is gone (not found).
    const row = await libraryItem(tx, ctx, mediaId);
    if (!canTrash(ctx, row)) throw forbidden("Only its uploader or an editor can restore this file.");
    if (!row.deletedAt) return { events: [] };
    await updateMediaRow(tx, ctx.org.id, ctx.site.id, row.id, { deletedAt: null });
    await record(tx, { action: "media.restored", resourceType: "media", resourceId: row.id, siteId: ctx.site.id, metadata: auditOf(row) }, ctx);
    return { events: [{ type: "media.restored", mediaId: row.id, siteId: ctx.site.id }] };
  });
}

// ── Folders ──────────────────────────────────────────────────────────────────

const FOLDER_TAKEN = "Another folder of this site already has this name.";

/** A folder's name: its display text, trimmed, without control characters, 1–100 characters. */
function folderName(value: unknown): string {
  const name = typeof value === "string" ? displayName(value.replace(/[/\\]/g, " ")) : null;
  if (!name) throw validationError({ name: ["Enter a name."] });
  if (name.length > FOLDER_NAME_MAX) throw validationError({ name: [`Use at most ${FOLDER_NAME_MAX} characters.`] });
  return name;
}

async function inSavepoint<T>(tx: TenantTx, work: (savepoint: TenantTx) => Promise<T>): Promise<T> {
  try {
    return await tx.transaction((savepoint) => work(savepoint as TenantTx));
  } catch (error) {
    if (isUniqueViolation(error, FOLDER_NAME_KEY)) throw validationError({ name: [FOLDER_TAKEN] });
    throw error;
  }
}

export async function createFolder(ctx: SiteContext, input: { name?: unknown }): Promise<{ folder: LibraryFolder }> {
  if (!canManageFolders(ctx)) throw forbidden();
  const name = folderName(input?.name);
  return inTenant(ctx, async (tx) => {
    const folder = await inSavepoint(tx, (s) => insertFolder(s, { organizationId: ctx.org.id, siteId: ctx.site.id, name, parentId: null }));
    await record(tx, { action: "media.folder_created", resourceType: "media_folder", resourceId: folder.id, siteId: ctx.site.id, metadata: { name } }, ctx);
    return { folder: { id: folder.id, name: folder.name, files: 0 } };
  });
}

async function folderOf(tx: TenantTx, ctx: SiteContext, folderId: unknown): Promise<FolderRow> {
  if (!z.uuid().safeParse(folderId).success) throw notFound();
  const folder = await findFolder(tx, ctx.org.id, ctx.site.id, folderId as string, "update");
  if (!folder) throw notFound();
  return folder;
}

export async function renameFolder(ctx: SiteContext, folderId: unknown, input: { name?: unknown }): Promise<{ changed: boolean }> {
  if (!canManageFolders(ctx)) throw forbidden();
  const name = folderName(input?.name);
  return inTenant(ctx, async (tx) => {
    const folder = await folderOf(tx, ctx, folderId);
    if (folder.name === name) return { changed: false };
    await inSavepoint(tx, (s) => renameFolderRow(s, ctx.org.id, ctx.site.id, folder.id, name));
    await record(tx, { action: "media.folder_renamed", resourceType: "media_folder", resourceId: folder.id, siteId: ctx.site.id, metadata: { name, previousName: folder.name } }, ctx);
    return { changed: true };
  });
}

/** Deletes an empty folder. Files in the trash do not keep it: they come back in no folder. */
export async function deleteFolder(ctx: SiteContext, folderId: unknown): Promise<void> {
  if (!canManageFolders(ctx)) throw forbidden();
  await inTenant(ctx, async (tx) => {
    const folder = await folderOf(tx, ctx, folderId);
    const files = await filesKeepingFolder(tx, ctx.org.id, ctx.site.id, folder.id);
    if (files) throw conflict(`${folder.name} still holds ${files} ${files === 1 ? "file" : "files"}. Move or trash ${files === 1 ? "it" : "them"} first.`);
    await deleteFolderRow(tx, ctx.org.id, ctx.site.id, folder.id);
    await record(tx, { action: "media.folder_deleted", resourceType: "media_folder", resourceId: folder.id, siteId: ctx.site.id, metadata: { name: folder.name } }, ctx);
  });
}

/** The folder files are uploaded into (M6-3): one of this site's, locked so it cannot be deleted under the upload. */
export async function uploadFolder(tx: TenantTx, ctx: SiteContext, folderId: unknown): Promise<string | null> {
  if (folderId === undefined || folderId === null || folderId === "") return null;
  if (!z.uuid().safeParse(folderId).success) throw validationError({ folderId: ["Choose a folder of this site."] });
  const folder = await findFolder(tx, ctx.org.id, ctx.site.id, folderId as string, "share");
  if (!folder) throw validationError({ folderId: ["Choose a folder of this site."] });
  return folder.id;
}

