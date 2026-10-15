import "server-only";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { record } from "@/modules/audit";
import { assertLimit } from "@/modules/billing";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import { asAppError, conflict, notFound, unavailable, validationError, type FieldErrors } from "@/platform/errors";
import { reportError } from "@/platform/observability";
import { isStorageError, mediaObjectKey, storageErrorToAppError, storageFor, type ObjectInfo, type StorageDriver } from "@/platform/storage";
import { ImageRejected, processImage } from "./processing";
import {
  ACCEPTED_LABEL, checkFile, keyNameOf, MAX_FILES_PER_REQUEST, SNIFF_BYTES, sniffType, UPLOAD_TARGET_SECONDS, UPLOAD_TYPES, uploadTypeOf, type AcceptedFile,
  type MediaKind, type UploadMimeType,
} from "./policy";
import {
  claimUpload, findMedia, insertMedia, objectKeysOf, recordVariants, releaseUpload, settleFailed, settleReady, siteExists, type MediaRow, type NewMediaRow,
} from "./repository";
import { uploadFolder } from "./library.service";
import type { MediaVariant } from "./schema";

/**
 * The upload protocol (M6-1; plan §8, ADR 0020): files go from the browser
 * straight to object storage, never through this app.
 *
 *   requestUploads(files)   media.upload. Checks each file's type and size, and the organization's storage limit,
 *                           under the organization's lock; creates one `pending` row per file; returns a target per
 *                           file (a presigned PUT, 10 minutes, signed for exactly that type and size, create only).
 *   (the browser PUTs each file to its target)
 *   completeUpload(id)      media.upload, the uploader's own pending upload. Looks at what storage holds: its size
 *                           must be the declared one, its first bytes the declared type's signature. An image is
 *                           then processed into its variants (M6-2, ./processing.ts) and their real bytes checked
 *                           against the storage limit. Then `ready` (audited), or the objects are deleted and the
 *                           row `failed`.
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

export type UploadedMedia = {
  id: string;
  kind: MediaKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** An image's size (after auto-rotation); null for a document. */
  width: number | null;
  height: number | null;
  /** What it stores in all: the original and, for an image, its variants (what counts towards the storage limit). */
  storedBytes: number;
};

export type UploadOutcome =
  | { status: "ready"; media: UploadedMedia }
  | { status: "failed"; mediaId: string; message: string; code?: "LimitExceeded" };

const NOT_ARRIVED = "The file has not reached storage yet. Send it again, then finish the upload.";
const REFUSED_BEFORE = "This upload was refused or has expired. Upload the file again.";
const BEING_FINISHED = "This upload is still being finished. Try again in a moment.";

/**
 * How long a completion holds an upload it processes (M6-2). Longer than any Vercel function may run (800 s), as a
 * job's claim (ADR 0005): a live completion never loses it, and a crashed one's runs out.
 */
export const PROCESSING_HOLD_SECONDS = 900;
/** How long a second completion of the same upload waits for the first before answering "try again". */
const WAIT_FOR_HOLDER_MS = 20_000;
const POLL_MS = 150;

const summaryOf = (row: MediaRow): UploadedMedia => ({
  id: row.id, kind: row.kind, filename: row.originalFilename, mimeType: row.mimeType, sizeBytes: row.sizeBytes, width: row.width, height: row.height,
  storedBytes: row.sizeBytes + row.variantBytes,
});

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

/**
 * `options.folderId`: the folder they go into (M6-3), one of this site's (none: no folder). It is locked while the
 * rows are written, so it cannot be deleted under them; another site's, or none at all, refuses the request.
 */
export async function requestUploads(ctx: SiteContext, files: unknown, options: { folderId?: unknown } = {}): Promise<{ uploads: IssuedUpload[] }> {
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
      const folderId = await uploadFolder(tx, ctx, options.folderId);
      // Locks the organization: concurrent requests take turns, each counting the others' reservations.
      await assertLimit(tx, ctx.org.id, "storage", total);
      const rows: NewMediaRow[] = accepted.map((file) => {
        const id = uuidv7();
        return {
          id,
          organizationId: ctx.org.id,
          siteId: ctx.site.id,
          folderId,
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The hold on this upload, or what it became meanwhile. A second completion of the same upload waits for the first
 * (it answers what the first settled), takes over when the first's hold ran out, or after a while says to try again.
 */
async function hold(ctx: SiteContext, id: string, waitMs: number): Promise<{ token: string; row: MediaRow } | { settled: UploadOutcome }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = uuidv7();
    const row = await inTenant(ctx, (tx) => claimUpload(tx, ctx.org.id, ctx.site.id, id, token, PROCESSING_HOLD_SECONDS));
    if (row) return { token, row };
    const now = await inTenant(ctx, (tx) => findMedia(tx, ctx.org.id, ctx.site.id, id));
    if (!now || now.deletedAt || now.status !== "pending") return { settled: outcomeOf(now) };
    if (Date.now() > deadline) throw conflict(BEING_FINISHED);
    await sleep(POLL_MS);
  }
}

/** Deletes these objects; true when all are gone. Never throws: a failure is reported, and the row still names them. */
async function deleteObjects(ctx: SiteContext, storage: StorageDriver, keys: string[]): Promise<boolean> {
  const results = await Promise.allSettled(keys.map((key) => storage.delete(key)));
  const failed = results.filter((result) => result.status === "rejected");
  for (const result of failed) reportError(result.reason, { module: "media", requestId: ctx.requestId });
  return failed.length === 0;
}

const variantKeyOf = (row: MediaRow, variant: string, ext: "webp" | "png") => {
  // The original's key ends `/original/{name}.{ext}`: a variant keeps the media id, the version and the name.
  const name = row.storageKey.slice(row.storageKey.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
  return mediaObjectKey({ organizationId: row.organizationId, siteId: row.siteId, mediaId: row.id, version: row.version, variant, name, ext });
};

export async function completeUpload(ctx: SiteContext, mediaId: unknown, options: { waitMs?: number } = {}): Promise<UploadOutcome> {
  requirePermission(ctx, "media.upload");
  if (!z.uuid().safeParse(mediaId).success) throw notFound();
  const id = mediaId as string;

  const first = await inTenant(ctx, (tx) => findMedia(tx, ctx.org.id, ctx.site.id, id));
  // Finishing an upload is its uploader's step. Anyone else's, another site's, a trashed one: no such upload.
  if (!first || first.deletedAt || first.uploadedBy !== ctx.actor.userId) throw notFound();
  if (first.status !== "pending") return outcomeOf(first);

  const held = await hold(ctx, id, options.waitMs ?? WAIT_FOR_HOLDER_MS);
  if ("settled" in held) return held.settled;
  const { token } = held;
  let row = held.row;
  const storage = scopedStorage(ctx);

  /** The file's fault: `failed` (only by the holder, so nothing can make it ready afterwards), then every object deleted. */
  const refuse = async (message: string, code?: "LimitExceeded"): Promise<UploadOutcome> => {
    const failed = await inTenant(ctx, (tx) => settleFailed(tx, ctx.org.id, ctx.site.id, id, token));
    if (!failed) return outcomeOf(await inTenant(ctx, (tx) => findMedia(tx, ctx.org.id, ctx.site.id, id)));
    // If a delete fails, the row still names the object, and `uploads.cleanup` deletes it again.
    await deleteObjects(ctx, storage, objectKeysOf(failed));
    return { status: "failed", mediaId: id, message, ...(code ? { code } : {}) };
  };

  try {
    // A completion that stopped half-way (its hold ran out) may have left variants: the row names them all.
    if (row.variants.length) {
      if (!(await deleteObjects(ctx, storage, row.variants.map((variant) => variant.storageKey)))) throw unavailable();
      await inTenant(ctx, (tx) => recordVariants(tx, ctx.org.id, ctx.site.id, id, token, []));
      row = { ...row, variants: [] };
    }

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
    if (refusal) return await refuse(refusal);

    let ready: { width: number | null; height: number | null; variants: MediaVariant[]; variantBytes: number } = { width: null, height: null, variants: [], variantBytes: 0 };
    if (row.kind === "image") {
      const original = await storageStep(async () => new Uint8Array(await new Response((await storage.get(row.storageKey)).body).arrayBuffer()));
      let processed;
      try {
        processed = await processImage(original, row.mimeType as UploadMimeType, { label: { mediaId: id, requestId: ctx.requestId } });
      } catch (error) {
        if (error instanceof ImageRejected) return await refuse(`${row.originalFilename} ${error.message}.`);
        throw error;
      }
      const variants: MediaVariant[] = processed.variants.map((variant) => ({
        key: variant.key, format: variant.format, width: variant.width, height: variant.height, sizeBytes: variant.data.byteLength, storageKey: variantKeyOf(row, variant.key, variant.format),
      }));
      // Write-ahead: the row names each object before it exists. Then they are stored.
      if (!(await inTenant(ctx, (tx) => recordVariants(tx, ctx.org.id, ctx.site.id, id, token, variants)))) {
        return outcomeOf(await inTenant(ctx, (tx) => findMedia(tx, ctx.org.id, ctx.site.id, id)));
      }
      // Every write settles before anything else happens: a failure is handled only once nothing is still in flight,
      // so the clean-up below cannot run before a write that would then land untracked.
      await storageStep(async () => {
        const writes = await Promise.allSettled(
          processed.variants.map((variant, i) => storage.put(variants[i]!.storageKey, variant.data, { contentType: `image/${variant.format}`, cacheControl: "public, max-age=31536000, immutable" })),
        );
        const failure = writes.find((write) => write.status === "rejected");
        if (failure) throw failure.reason;
      });
      ready = { width: processed.width, height: processed.height, variants, variantBytes: variants.reduce((sum, variant) => sum + variant.sizeBytes, 0) };
    }

    try {
      return await inTenant(ctx, async (tx) => {
        // The variants' real bytes, under the organization's lock: the original is already counted (its reservation).
        if (ready.variantBytes) await assertLimit(tx, ctx.org.id, "storage", ready.variantBytes);
        const settled = await settleReady(tx, ctx.org.id, ctx.site.id, id, token, ready);
        // The hold ran out under us (this cannot happen within a function's lifetime): report what it is now.
        if (!settled) return outcomeOf(await findMedia(tx, ctx.org.id, ctx.site.id, id));
        await record(
          tx,
          { action: "media.uploaded", resourceType: "media", resourceId: settled.id, siteId: ctx.site.id, metadata: { kind: settled.kind, filename: settled.originalFilename, sizeBytes: settled.sizeBytes } },
          ctx,
        );
        return { status: "ready", media: summaryOf(settled) } as const;
      });
    } catch (error) {
      const appError = asAppError(error);
      if (appError?.kind === "LimitExceeded") return await refuse(appError.message, "LimitExceeded");
      throw error;
    }
  } catch (error) {
    await letGo(ctx, storage, id, token);
    throw error;
  }
}

/**
 * After a failure that is not the file's (storage, the database): the variants this completion wrote are deleted and
 * the hold let go, so the upload is still pending and completing it again starts over. Only while this completion
 * still holds it: otherwise the row and its objects are someone else's. Variants that could not be deleted stay
 * named on the row, for the next completion or the cleanup.
 */
async function letGo(ctx: SiteContext, storage: StorageDriver, id: string, token: string): Promise<void> {
  try {
    const row = await inTenant(ctx, (tx) => findMedia(tx, ctx.org.id, ctx.site.id, id));
    if (!row || row.status !== "pending" || row.processingToken !== token) return;
    const deleted = await deleteObjects(ctx, storage, row.variants.map((variant) => variant.storageKey));
    await inTenant(ctx, (tx) => releaseUpload(tx, ctx.org.id, ctx.site.id, id, token, { variantsDeleted: deleted }));
  } catch (error) {
    // The database is down too: the hold runs out by itself, and the row still names every object.
    reportError(error, { module: "media", requestId: ctx.requestId });
  }
}
