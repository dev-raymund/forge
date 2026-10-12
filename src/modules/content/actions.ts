"use server";

import { getCurrentActor } from "@/modules/auth";
import { currentRequestMeta, finish } from "@/modules/tenancy";
import type { FormState } from "@/platform/forms";
import { submitCreateEntry, submitPublishEntry, submitSaveDraft, submitSetHomepage } from "./entry-forms";

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
