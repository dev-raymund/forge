import "server-only";
import { isCurrentAvatar } from "@/modules/auth";
import { withPlatform } from "@/platform/db";
import { isStorageKey, storageFor, storageForUser, type StorageDriver } from "@/platform/storage";
import { publicMediaObject } from "./repository";

/**
 * What `/media/{key}` may serve (M6-2; plan §8, ADR 0006): only an object an authoritative record says is public
 * now, never "any key that exists in storage".
 *
 *   o/{org}/s/{site}/m/{media}/v{n}/{variant}/{name}.webp   a variant of a ready, untrashed image
 *   o/{org}/s/{site}/m/{media}/v{n}/original/{name}.pdf     the file of a ready, untrashed document
 *   u/{user}/a/{avatar}/thumb/avatar.webp                    a user's current avatar
 *
 * Not served: an image's original (its metadata, GPS included, is still in it), anything pending, refused, trashed
 * or replaced, and any key of another shape. The content type is the record's, never the request's or the
 * object's; only these types are ever served, and never HTML, script or SVG.
 */

export const DELIVERABLE_TYPES = ["image/webp", "image/jpeg", "image/png", "image/gif", "application/pdf"] as const;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MEDIA_KEY = new RegExp(`^o/(${UUID})/s/(${UUID})/m/(${UUID})/v[1-9][0-9]{0,4}/[a-z0-9]{1,32}/[a-z0-9]+(?:-[a-z0-9]+)*\\.[a-z0-9]{1,8}$`);
const AVATAR_KEY = new RegExp(`^u/(${UUID})/a/${UUID}/thumb/avatar\\.webp$`);

export type Deliverable = {
  contentType: (typeof DELIVERABLE_TYPES)[number];
  /** PDFs open in the browser; everything else downloads when opened directly (plan §8). An `<img>` shows either. */
  disposition: "inline" | "attachment";
  /** The key's last segment: made by the server (ASCII words), never a name someone typed. */
  filename: string;
  storage: StorageDriver;
};

const deliverable = (contentType: string, key: string, storage: StorageDriver): Deliverable | null =>
  (DELIVERABLE_TYPES as readonly string[]).includes(contentType)
    ? { contentType: contentType as Deliverable["contentType"], disposition: contentType === "application/pdf" ? "inline" : "attachment", filename: key.slice(key.lastIndexOf("/") + 1), storage }
    : null;

/** The object at `key` if it may be served, with how; null for anything else (one answer: not found). */
export async function deliverableObject(key: string): Promise<Deliverable | null> {
  if (!isStorageKey(key)) return null;
  const media = MEDIA_KEY.exec(key);
  if (media) {
    const [, organizationId, siteId, mediaId] = media;
    const found = await withPlatform((tx) => publicMediaObject(tx, mediaId!, key));
    // The record's own organization and site scope the read: a key naming another tenant's prefix is refused there too.
    if (!found || found.organizationId !== organizationId || found.siteId !== siteId) return null;
    return deliverable(found.contentType, key, storageFor({ organizationId: found.organizationId, siteId: found.siteId }));
  }
  const avatar = AVATAR_KEY.exec(key);
  if (avatar && (await isCurrentAvatar(avatar[1]!, key))) return deliverable("image/webp", key, storageForUser(avatar[1]!));
  return null;
}
