import "server-only";
import { eq, sql } from "drizzle-orm";
import { mediaPublicBaseUrl } from "@/platform/config/env";
import { identityDb } from "@/platform/db/identity";
import type { Tx } from "@/platform/db/tenant";
import { users } from "./schema";

/**
 * The account's picture (M6-2, moved from M2-4): `users.image`.
 *
 * The browser never sets it: `/update-user` still takes the name only (`EDITABLE_PROFILE_FIELDS`). It is set here,
 * on the server, to the URL of an avatar the media module processed and stored under the user's own prefix
 * (`/media/u/{userId}/a/{avatarId}/thumb/avatar.webp`). A Google account may hold Google's picture URL there from
 * sign-up; that one is never shown (`ownAvatarUrl`) and is replaced by the first upload.
 */

/** The user's picture as stored (any URL), or null. */
export async function accountImageOf(userId: string): Promise<string | null> {
  const [row] = await identityDb().select({ image: users.image }).from(users).where(eq(users.id, userId));
  return row?.image ?? null;
}

/** Is `key` this user's current avatar? `/media/{key}` serves an avatar only then. */
export async function isCurrentAvatar(userId: string, key: string): Promise<boolean> {
  const image = await accountImageOf(userId);
  return image !== null && image.endsWith(`/${key}`) && key.startsWith(`u/${userId}/a/`);
}

/**
 * Points the user's picture at `url`, in one transaction with the caller's bookkeeping (`work`, given the previous
 * picture: e.g. enqueueing its deletion). The user's row is locked first, so two switches take turns.
 */
export async function switchAccountImage(userId: string, url: string | null, work: (tx: Tx, previous: string | null) => Promise<void>): Promise<string | null> {
  return identityDb().transaction(async (tx) => {
    const [row] = await tx.select({ image: users.image }).from(users).where(eq(users.id, userId)).for("update");
    if (!row) throw new Error("No such user");
    await tx.update(users).set({ image: url, updatedAt: sql`now()` }).where(eq(users.id, userId));
    await work(tx, row.image);
    return row.image;
  });
}

/** The picture to show for this user: their own uploaded avatar, or null (initials). Another site's URL is never shown. */
export function ownAvatarUrl(user: { id: string; image: string | null }): string | null {
  const own = `${mediaPublicBaseUrl()}/u/${user.id}/a/`;
  return user.image?.startsWith(own) && /^[a-z0-9/.-]+$/.test(user.image.slice(own.length)) ? user.image : null;
}
