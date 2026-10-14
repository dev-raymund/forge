import "server-only";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { isCurrentAvatar, switchAccountImage } from "@/modules/auth";
import { withPlatform } from "@/platform/db";
import { conflict, notFound, validationError } from "@/platform/errors";
import { defineJob, enqueue } from "@/platform/jobs";
import { reportError } from "@/platform/observability";
import { avatarObjectKey, isStorageError, isStorageKey, storageErrorToAppError, storageForUser } from "@/platform/storage";
import { checkFile, SNIFF_BYTES, sniffType, UPLOAD_TARGET_SECONDS, uploadTypeOf, type UploadMimeType } from "./policy";
import { ImageRejected, processImage } from "./processing";

/**
 * The account avatar (M6-2, moved from M2-4): uploaded and processed like other media, but the user's own, not an
 * organization's. No media row: the user's picture is `users.image` (the auth module's), and the files live under
 * `u/{userId}/a/{avatarId}/…` in the user's own storage scope.
 *
 *   requestAvatarUpload(userId, file)   an image (JPEG, PNG, WebP, GIF; the media size limit); a presigned PUT to
 *                                       `…/original/avatar.upload`, 10 minutes, signed for its type and size, once
 *   (the browser PUTs the file)
 *   completeAvatarUpload(userId, id)    checks what storage holds (stored type, its first bytes), processes it into a
 *                                       square of 400 (WebP, metadata stripped) at `…/thumb/avatar.webp`, and points
 *                                       the user's picture at it
 *
 * Nothing is ever untracked: before an object can exist, an `avatars.collect` job is queued to delete it an hour
 * later unless it is then the user's current avatar. The original is never kept (that job always deletes it, and
 * completion deletes it at once); a replaced avatar is collected as soon as it is replaced. Avatars do not count
 * towards any organization's storage: they are nobody's media.
 */

const COLLECT_AFTER_MS = 60 * 60 * 1000;
const NOT_ARRIVED = "The picture has not reached storage yet. Try again.";

/** Deletes an avatar object unless it is the user's current avatar (then, later, its replacement queues it again). */
export const avatarsCollect = defineJob({
  type: "avatars.collect",
  scope: "platform",
  payload: z.object({ userId: z.uuid(), key: z.string() }).refine((p) => isStorageKey(p.key) && p.key.startsWith(`u/${p.userId}/a/`), "not an avatar key of this user"),
  run: async ({ userId, key }, ctx) => {
    if (await isCurrentAvatar(userId, key)) {
      ctx.log.info("avatars.collect: still the user's avatar, kept", { userId });
      return;
    }
    await storageForUser(userId).delete(key);
  },
});

const collectLater = (userId: string, key: string) =>
  withPlatform((tx) => enqueue(tx, avatarsCollect, { userId, key }, { runAt: new Date(Date.now() + COLLECT_AFTER_MS) }));

async function storageStep<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw isStorageError(error) ? storageErrorToAppError(error) : error;
  }
}

export type IssuedAvatarUpload = { avatarId: string; upload: { method: "PUT"; url: string; headers: Record<string, string>; expiresAt: string } };

export async function requestAvatarUpload(userId: string, file: unknown): Promise<IssuedAvatarUpload> {
  const checked = checkFile(file);
  if (!checked.ok) throw validationError({ file: [checked.message] }, checked.message);
  const NOT_AN_IMAGE = "A picture is an image: upload a JPEG, PNG, WebP or GIF file.";
  if (checked.file.type.kind !== "image") throw validationError({ file: [NOT_AN_IMAGE] }, NOT_AN_IMAGE);
  const avatarId = uuidv7();
  const key = avatarObjectKey({ userId, avatarId, variant: "original", ext: "upload" });
  // Tracked before it can exist: deleted in an hour whatever happens (an original is never kept).
  await collectLater(userId, key);
  const target = await storageStep(() =>
    storageForUser(userId).createUpload({ key, contentType: checked.file.mimeType, contentLength: checked.file.size, expiresInSeconds: UPLOAD_TARGET_SECONDS }),
  );
  return { avatarId, upload: { method: "PUT", url: target.url, headers: target.headers, expiresAt: target.expiresAt.toISOString() } };
}

/** The avatar key a stored picture URL points at, when it is one of this user's avatars. */
function avatarKeyOf(userId: string, url: string | null): string | null {
  const match = url?.match(new RegExp(`(u/${userId}/a/[0-9a-f-]{36}/thumb/avatar\\.webp)$`));
  return match ? match[1]! : null;
}

export async function completeAvatarUpload(userId: string, avatarId: unknown): Promise<{ url: string }> {
  if (!z.uuid().safeParse(avatarId).success) throw notFound();
  const storage = storageForUser(userId);
  const original = avatarObjectKey({ userId, avatarId: avatarId as string, variant: "original", ext: "upload" });
  const thumb = avatarObjectKey({ userId, avatarId: avatarId as string, variant: "thumb", ext: "webp" });
  const refuse = async (message: string): Promise<never> => {
    await storage.delete(original).catch((error) => reportError(error, { module: "media" })); // its collect job deletes it otherwise
    throw validationError({ file: [message] }, message);
  };

  // The stored type and size are the ones `requestAvatarUpload` checked and signed: no other link writes this key.
  const info = await storageStep(() => storage.head(original));
  if (!info) throw conflict(NOT_ARRIVED);
  const type = uploadTypeOf(info.contentType);
  if (!type || type.kind !== "image" || info.size > type.maxBytes) return refuse("This picture can't be used. Upload a JPEG, PNG, WebP or GIF file.");
  const bytes = await storageStep(async () => {
    const head = await storage.readRange(original, 0, SNIFF_BYTES - 1);
    if (sniffType(head) !== info.contentType) return null;
    return new Uint8Array(await new Response((await storage.get(original)).body).arrayBuffer());
  });
  if (!bytes) return refuse(`This picture is not a ${type.label} file. Upload a JPEG, PNG, WebP or GIF file.`);

  let processed;
  try {
    processed = await processImage(bytes, info.contentType as UploadMimeType, { preset: "avatar", label: { userId } });
  } catch (error) {
    if (error instanceof ImageRejected) return refuse(`This picture ${error.message}.`);
    throw error;
  }
  const [square] = processed.variants;
  // Tracked before it is written: collected in an hour unless it is then the user's avatar.
  await collectLater(userId, thumb);
  await storageStep(async () => {
    try {
      await storage.put(thumb, square!.data, { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" });
    } catch (error) {
      // Written already by a completion of this same avatar (a retry, or one at the same moment), from the same
      // checked original: only the server writes this key. Use it.
      if (!isStorageError(error, "AlreadyExists")) throw error;
    }
  });
  const url = storage.publicUrl(thumb);
  await switchAccountImage(userId, url, async (tx, previous) => {
    const replaced = avatarKeyOf(userId, previous);
    if (replaced && replaced !== thumb) await enqueue(tx, avatarsCollect, { userId, key: replaced });
  });
  await storage.delete(original).catch((error) => reportError(error, { module: "media" }));
  return { url };
}

