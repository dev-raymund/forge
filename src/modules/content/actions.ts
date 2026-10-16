"use server";

import { getCurrentActor } from "@/modules/auth";
import { currentRequestMeta, finish } from "@/modules/tenancy";
import type { ActionResult } from "@/platform/errors";
import type { FormState } from "@/platform/forms";
import {
  submitCancelSchedule, submitChangeAuthor, submitCreateEntry, submitDraftHead, submitMovePage, submitPreviewLink, submitOverwriteDraft, submitPlacePage, submitPublishEntry, submitPurgeEntry,
  submitRescheduleEntry, submitRestoreEntry, submitRestoreRevision, submitRevisionHistory, submitSaveDraft, submitSaveRevision, submitScheduleEntry, submitSetHomepage,
  submitTrashEntry, submitUnpublishEntry,
} from "./entry-forms";
import type { PreviewLink } from "./preview.service";
import type { DraftHeadInfo, RevisionList } from "./queries";
import { submitCreateTerm, submitDeleteTerm, submitUpdateTerm } from "./term-forms";

/**
 * The entry Server Actions (M5-3): session → ./entry-forms.ts → flush the
 * returned cache events (`invalidate`) → state. The screens that bind them are
 * M5-4's and M5-7's.
 *
 * `orgSlug`, `siteSlug`, `type` and `entryId` are bound by the page from its
 * own URL. Like any argument of a Server Action they can be forged, and that is
 * fine: they name things and grant nothing. The resolver checks the session's
 * user against the organization's members and the site against the
 * organization; the services look the entry up in that site and ask for the
 * permission, on every call.
 */

export async function createEntryAction(orgSlug: string, siteSlug: string, type: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitCreateEntry(await getCurrentActor(), orgSlug, siteSlug, type, formData, await currentRequestMeta()));
}

export async function saveDraftAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitSaveDraft(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function publishEntryAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitPublishEntry(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function setHomepageAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitSetHomepage(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

// M5-7: the page tree and the author.

export async function movePageAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitMovePage(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function placePageAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitPlacePage(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function changeAuthorAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitChangeAuthor(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

// M5-8: categories and tags.

export async function createTermAction(orgSlug: string, siteSlug: string, taxonomy: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitCreateTerm(await getCurrentActor(), orgSlug, siteSlug, taxonomy, formData, await currentRequestMeta()));
}

export async function updateTermAction(orgSlug: string, siteSlug: string, termId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitUpdateTerm(await getCurrentActor(), orgSlug, siteSlug, termId, formData, await currentRequestMeta()));
}

export async function deleteTermAction(orgSlug: string, siteSlug: string, termId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitDeleteTerm(await getCurrentActor(), orgSlug, siteSlug, termId, formData, await currentRequestMeta()));
}

// M7-1: the lifecycle.

export async function unpublishEntryAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitUnpublishEntry(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function trashEntryAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitTrashEntry(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function restoreEntryAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitRestoreEntry(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function purgeEntryAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitPurgeEntry(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

// M7-2: scheduling.

export async function scheduleEntryAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitScheduleEntry(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function rescheduleEntryAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitRescheduleEntry(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function cancelScheduleAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitCancelSchedule(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

// M7-3: the history, and the conflict dialog's overwrite.

export async function saveRevisionAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitSaveRevision(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function restoreRevisionAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitRestoreRevision(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

export async function overwriteDraftAction(orgSlug: string, siteSlug: string, entryId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitOverwriteDraft(await getCurrentActor(), orgSlug, siteSlug, entryId, formData, await currentRequestMeta()));
}

/** The entry's history, for its dialog. Read-only. */
export async function revisionHistoryAction(orgSlug: string, siteSlug: string, entryId: string, before?: number): Promise<ActionResult<RevisionList>> {
  return submitRevisionHistory(await getCurrentActor(), orgSlug, siteSlug, entryId, before, await currentRequestMeta());
}

/** Who saved the draft last, and when, for the conflict dialog. Read-only. */
export async function draftHeadAction(orgSlug: string, siteSlug: string, entryId: string): Promise<ActionResult<DraftHeadInfo>> {
  return submitDraftHead(await getCurrentActor(), orgSlug, siteSlug, entryId, await currentRequestMeta());
}

// M7-4: previews.

/** A 15-minute preview link for the draft, or for a revision (the history's preview). Read-only. */
export async function previewLinkAction(orgSlug: string, siteSlug: string, entryId: string, revisionId?: string): Promise<ActionResult<PreviewLink>> {
  return submitPreviewLink(await getCurrentActor(), orgSlug, siteSlug, entryId, revisionId, await currentRequestMeta());
}
