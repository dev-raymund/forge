"use server";

import { getCurrentActor } from "@/modules/auth";
import { currentRequestMeta, finish } from "@/modules/tenancy";
import type { FormState } from "@/platform/forms";
import { submitChangeSiteAddress, submitChooseTheme, submitCreateSite, submitDeleteSite, submitSetSiteStatus, submitUpdateSiteSettings } from "./site-forms";

/**
 * The site forms' Server Actions (M4-1): session → ./site-forms.ts → invalidate → redirect or state.
 *
 * `orgSlug` and `siteSlug` are bound by the page from its own URL. Like any
 * argument of a Server Action they can be forged, and that is fine: they name
 * an organization and a site, they grant neither. The resolver checks the
 * session's user against that organization's members, and the site against
 * that organization, on every call.
 */

/** `flow` is bound by the page: the admin's create-site page, or onboarding's step 2 (M4-2). */
export async function createSiteAction(orgSlug: string, flow: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitCreateSite(await getCurrentActor(), orgSlug, formData, await currentRequestMeta(), flow));
}

export async function changeSiteAddressAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitChangeSiteAddress(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}

export async function deleteSiteAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitDeleteSite(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}

export async function chooseThemeAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitChooseTheme(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}

/** Publishing, and back to Coming soon (M4-5): the form sends the status it asks for. */
export async function setSiteStatusAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitSetSiteStatus(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}

/** `group` is bound by the settings page: which of the site's settings groups the form saves. */
export async function updateSiteSettingsAction(orgSlug: string, siteSlug: string, group: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitUpdateSiteSettings(await getCurrentActor(), orgSlug, siteSlug, group, formData, await currentRequestMeta()));
}
