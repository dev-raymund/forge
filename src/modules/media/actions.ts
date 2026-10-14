"use server";

import { getCurrentActor } from "@/modules/auth";
import { currentRequestMeta } from "@/modules/tenancy";
import type { ActionResult } from "@/platform/errors";
import { kickJobs } from "@/platform/jobs";
import { avatarsCollect, type IssuedAvatarUpload } from "./avatar.service";
import { submitCompleteAvatarUpload, submitCompleteUpload, submitRequestAvatarUpload, submitRequestUploads } from "./upload-requests";
import type { IssuedUpload, UploadedMedia } from "./upload.service";

/**
 * The upload Server Actions (M6-1; plan §8): session → ./upload-requests.ts → result. The dropzone that calls them
 * is M6-3's, the picker's upload M6-4's.
 *
 * `orgSlug` and `siteSlug` are bound by the page from its own URL. Like any argument of a Server Action they can be
 * forged, and that is fine: they name an organization and a site, they do not grant them.
 *
 * Neither changes a public page (a new upload is in no content yet), so there is nothing to invalidate.
 */

export async function requestUploadsAction(orgSlug: string, siteSlug: string, files: unknown): Promise<ActionResult<{ uploads: IssuedUpload[] }>> {
  return submitRequestUploads(await getCurrentActor(), orgSlug, siteSlug, files, await currentRequestMeta());
}

export async function completeUploadAction(orgSlug: string, siteSlug: string, mediaId: unknown): Promise<ActionResult<UploadedMedia>> {
  return submitCompleteUpload(await getCurrentActor(), orgSlug, siteSlug, mediaId, await currentRequestMeta());
}

// The account avatar (M6-2), on /account. A replaced avatar is collected as soon as the response is sent.

export async function requestAvatarUploadAction(file: unknown): Promise<ActionResult<IssuedAvatarUpload>> {
  return submitRequestAvatarUpload(await getCurrentActor(), file, await currentRequestMeta());
}

export async function completeAvatarUploadAction(avatarId: unknown): Promise<ActionResult<{ url: string }>> {
  const result = await submitCompleteAvatarUpload(await getCurrentActor(), avatarId, await currentRequestMeta());
  if (result.ok) kickJobs([avatarsCollect]);
  return result;
}
