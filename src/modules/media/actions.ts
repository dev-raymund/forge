"use server";

import { getCurrentActor } from "@/modules/auth";
import { currentRequestMeta, finish } from "@/modules/tenancy";
import type { ActionResult } from "@/platform/errors";
import type { FormState } from "@/platform/forms";
import { kickJobs } from "@/platform/jobs";
import { avatarsCollect, type IssuedAvatarUpload } from "./avatar.service";
import {
  submitCreateFolder, submitDeleteFolder, submitMediaUsage, submitMoveMedia, submitRenameFolder, submitRestoreMedia, submitTrashMedia, submitUpdateMedia,
} from "./library-forms";
import type { MediaUsage } from "./library.service";
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

/** `folderId`: the folder they go into (M6-3), checked against the site; none: no folder. */
export async function requestUploadsAction(orgSlug: string, siteSlug: string, files: unknown, folderId: unknown = null): Promise<ActionResult<{ uploads: IssuedUpload[] }>> {
  return submitRequestUploads(await getCurrentActor(), orgSlug, siteSlug, files, await currentRequestMeta(), { folderId });
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

// The media library (M6-3): a file's details, its folder, the trash; the folders. Each ends as a form does (finish):
// the library page shows the change, and public pages drop what it made out of date.

export async function updateMediaAction(orgSlug: string, siteSlug: string, mediaId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitUpdateMedia(await getCurrentActor(), orgSlug, siteSlug, mediaId, formData, await currentRequestMeta()));
}

export async function moveMediaAction(orgSlug: string, siteSlug: string, mediaIds: unknown, folderId: unknown): Promise<FormState> {
  return finish(await submitMoveMedia(await getCurrentActor(), orgSlug, siteSlug, mediaIds, folderId, await currentRequestMeta()));
}

/** Where a file is used, for the warning before the trash (M7-1). Read-only. */
export async function mediaUsageAction(orgSlug: string, siteSlug: string, mediaId: string): Promise<ActionResult<MediaUsage>> {
  return submitMediaUsage(await getCurrentActor(), orgSlug, siteSlug, mediaId, await currentRequestMeta());
}

export async function trashMediaAction(orgSlug: string, siteSlug: string, mediaId: string): Promise<FormState> {
  return finish(await submitTrashMedia(await getCurrentActor(), orgSlug, siteSlug, mediaId, await currentRequestMeta()));
}

export async function restoreMediaAction(orgSlug: string, siteSlug: string, mediaId: string): Promise<FormState> {
  return finish(await submitRestoreMedia(await getCurrentActor(), orgSlug, siteSlug, mediaId, await currentRequestMeta()));
}

export async function createFolderAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitCreateFolder(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}

export async function renameFolderAction(orgSlug: string, siteSlug: string, folderId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitRenameFolder(await getCurrentActor(), orgSlug, siteSlug, folderId, formData, await currentRequestMeta()));
}

export async function deleteFolderAction(orgSlug: string, siteSlug: string, folderId: string): Promise<FormState> {
  return finish(await submitDeleteFolder(await getCurrentActor(), orgSlug, siteSlug, folderId, await currentRequestMeta()));
}
