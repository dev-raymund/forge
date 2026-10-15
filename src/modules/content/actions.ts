"use server";

import { getCurrentActor } from "@/modules/auth";
import { currentRequestMeta, finish } from "@/modules/tenancy";
import type { FormState } from "@/platform/forms";
import {
  submitChangeAuthor, submitCreateEntry, submitMovePage, submitPlacePage, submitPublishEntry, submitPurgeEntry, submitRestoreEntry, submitSaveDraft, submitSetHomepage,
  submitTrashEntry, submitUnpublishEntry,
} from "./entry-forms";
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
