import "server-only";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { record } from "@/modules/audit";
import { assertLimit } from "@/modules/billing";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import { conflict, notFound, validationError, type FieldErrors } from "@/platform/errors";
import { reportError } from "@/platform/observability";
import { isStorageError, mediaObjectKey, storageErrorToAppError, storageFor, type ObjectInfo, type StorageDriver } from "@/platform/storage";
import {
  ACCEPTED_LABEL, checkFile, keyNameOf, MAX_FILES_PER_REQUEST, SNIFF_BYTES, sniffType, UPLOAD_TARGET_SECONDS, UPLOAD_TYPES, uploadTypeOf, type AcceptedFile,
  type MediaKind,
} from "./policy";
import { findMedia, insertMedia, settleUpload, siteExists, type MediaRow, type NewMediaRow } from "./repository";

/**
 * The upload protocol (M6-1; plan §8, ADR 0020): files go from the browser
 * straight to object storage, never through this app.
 *
 *   requestUploads(files)   media.upload. Checks each file's type and size, and the organization's storage limit,
 *                           under the organization's lock; creates one `pending` row per file; returns a target per
 *                           file (a presigned PUT, 10 minutes, signed for exactly that type and size, create only).
 *   (the browser PUTs each file to its target)
 *   completeUpload(id)      media.upload, the uploader's own pending upload. Looks at what storage holds: its size
 *                           must be the declared one, its first bytes the declared type's signature. Then `ready`
 *                           (audited), or the object is deleted and the row `failed`.
 *
 * Nothing the browser says is taken as true: not that it uploaded, not what it uploaded, not where. The
 * organization and the site are the context's, the media id is looked up in that site, and the storage key
 * is always the row's own, made here.
 */

export type IssuedUpload = {
  mediaId: string;
  name: string;
  kind: MediaKind;
  /** PUT the file's bytes to `url` with exactly these headers, before `expiresAt`. */
  upload: { method: "PUT"; url: string; headers: Record<string, string>; expiresAt: string };
};

export type UploadedMedia = { id: string; kind: MediaKind; filename: string; mimeType: string; sizeBytes: number };

export type UploadOutcome = { status: "ready"; media: UploadedMedia } | { status: "failed"; mediaId: string; message: string };

const NOT_ARRIVED = "The file has not reached storage yet. Send it again, then finish the upload.";
const REFUSED_BEFORE = "This upload was refused or has expired. Upload the file again.";

const summaryOf = (row: MediaRow): UploadedMedia => ({ id: row.id, kind: row.kind, filename: row.originalFilename, mimeType: row.mimeType, sizeBytes: row.sizeBytes });

/** What a settled row says now: `ready`, or refused (by a check, or expired by the cleanup). Gone altogether: not found. */
function outcomeOf(row: MediaRow | null): UploadOutcome {
  if (!row) throw notFound();
  return row.status === "ready" ? { status: "ready", media: summaryOf(row) } : { status: "failed", mediaId: row.id, message: REFUSED_BEFORE };
}

/** Storage failures become the application's errors (unavailable, not found), never a success. */
async function storageStep<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw isStorageError(error) ? storageErrorToAppError(error) : error;
  }
}

const scopedStorage = (ctx: SiteContext): StorageDriver => storageFor({ organizationId: ctx.org.id, siteId: ctx.site.id });

export async function requestUploads(ctx: SiteContext, files: unknown): Promise<{ uploads: IssuedUpload[] }> {
  requirePermission(ctx, "media.upload");
  if (!Array.isArray(files) || files.length === 0) throw validationError({ files: ["Choose at least one file."] });
  if (files.length > MAX_FILES_PER_REQUEST) throw validationError({ files: [`Upload at most ${MAX_FILES_PER_REQUEST} files at a time.`] });

  const accepted: AcceptedFile[] = [];
  const refused: FieldErrors = {};
  files.forEach((file: unknown, index) => {
    const checked = checkFile(file);
    if (checked.ok) accepted.push(checked.file);
    else refused[`files.${index}`] = [checked.message];
  });
  // All or nothing: a request with a file that cannot be uploaded reserves nothing.
  if (Object.keys(refused).length) throw validationError(refused, "Some of these files can't be uploaded.");
  const total = accepted.reduce((sum, file) => sum + file.size, 0);

  const storage = scopedStorage(ctx);
  return storageStep(() =>
    inTenant(ctx, async (tx) => {
      if (!(await siteExists(tx, ctx.org.id, ctx.site.id))) throw notFound();
      // Locks the organization: concurrent requests take turns, each counting the others' reservations.
      await assertLimit(tx, ctx.org.id, "storage", total);
      const rows: NewMediaRow[] = accepted.map((file) => {
        const id = uuidv7();
        return {
          id,
          organizationId: ctx.org.id,
          siteId: ctx.site.id,
          kind: file.type.kind,
          status: "pending",
          storageDriver: storage.name,
          // Opaque and made here: the tenant prefix, a fresh id, the type's extension. The name is a readable hint only.
          storageKey: mediaObjectKey({ organizationId: ctx.org.id, siteId: ctx.site.id, mediaId: id, version: 1, variant: "original", name: keyNameOf(file.name), ext: file.type.ext }),
          version: 1,
          originalFilename: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.size,
          uploadedBy: ctx.actor.userId,
        };
      });
      const inserted = await insertMedia(tx, rows);
      // Signed before the commit: if any signing fails, no row is left reserving storage.
      const uploads: IssuedUpload[] = [];
      for (const row of inserted) {
        const target = await storage.createUpload({ key: row.storageKey, contentType: row.mimeType, contentLength: row.sizeBytes, expiresInSeconds: UPLOAD_TARGET_SECONDS });
        uploads.push({
          mediaId: row.id,
          name: row.originalFilename,
          kind: row.kind,
          upload: { method: "PUT", url: target.url, headers: target.headers, expiresAt: target.expiresAt.toISOString() },
        });
      }
      return { uploads };
    }),
  );
}

/** Why storage's object is not the file that was announced, or null when it is. Reads its size, its type, its first 4 KB. */
async function refusalOf(storage: StorageDriver, row: MediaRow, info: ObjectInfo): Promise<string | null> {
  const declared = uploadTypeOf(row.mimeType);
  const name = row.originalFilename;
  if (!declared) return `${name} can't be uploaded. Upload ${ACCEPTED_LABEL} files.`;
  if (info.size !== row.sizeBytes) return `${name} did not arrive as it was sent (its size differs). Upload it again.`;
  if (info.contentType.toLowerCase() !== row.mimeType) return `${name} was not stored as a ${declared.label} file. Upload it again.`;
  const sniffed = sniffType(await storage.readRange(row.storageKey, 0, SNIFF_BYTES - 1));
  if (sniffed === row.mimeType) return null;
  return sniffed
    ? `${name} is a ${UPLOAD_TYPES[sniffed]!.label} file, but was sent as ${declared.label}. Give it the right extension and upload it again.`
    : `${name} is not a ${declared.label} file. Upload ${ACCEPTED_LABEL} files.`;
}

export async function completeUpload(ctx: SiteContext, mediaId: unknown): Promise<UploadOutcome> {
  requirePermission(ctx, "media.upload");
  if (!z.uuid().safeParse(mediaId).success) throw notFound();
  const id = mediaId as string;

  const row = await inTenant(ctx, (tx) => findMedia(tx, ctx.org.id, ctx.site.id, id));
  // Finishing an upload is its uploader's step. Anyone else's, another site's, a trashed one: no such upload.
  if (!row || row.deletedAt || row.uploadedBy !== ctx.actor.userId) throw notFound();
  if (row.status !== "pending") return outcomeOf(row);

  const storage = scopedStorage(ctx);
  const refusal = await storageStep(async () => {
    const info = await storage.head(row.storageKey);
    if (!info) throw conflict(NOT_ARRIVED);
    try {
      return await refusalOf(storage, row, info);
    } catch (error) {
      // Gone between the two reads (the cleanup removed it): as if it had never arrived.
      if (isStorageError(error, "NotFound")) throw conflict(NOT_ARRIVED);
      throw error;
    }
  });

  if (refusal) {
    const failed = await inTenant(ctx, (tx) => settleUpload(tx, ctx.org.id, ctx.site.id, id, "failed"));
    if (!failed) return outcomeOf(await inTenant(ctx, (tx) => findMedia(tx, ctx.org.id, ctx.site.id, id)));
    // The row no longer counts and can never become `ready`. If the delete fails, `uploads.cleanup` deletes it again.
    await storage.delete(row.storageKey).catch((error) => reportError(error, { module: "media", requestId: ctx.requestId }, { mediaId: id }));
    return { status: "failed", mediaId: id, message: refusal };
  }

  return inTenant(ctx, async (tx) => {
    const ready = await settleUpload(tx, ctx.org.id, ctx.site.id, id, "ready");
    // A concurrent completion got there first (and recorded it), or the cleanup expired it: report what it is.
    if (!ready) return outcomeOf(await findMedia(tx, ctx.org.id, ctx.site.id, id));
    await record(
      tx,
      { action: "media.uploaded", resourceType: "media", resourceId: ready.id, siteId: ctx.site.id, metadata: { kind: ready.kind, filename: ready.originalFilename, sizeBytes: ready.sizeBytes } },
      ctx,
    );
    return { status: "ready", media: summaryOf(ready) };
  });
}
