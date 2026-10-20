"use server";

import { getCurrentActor } from "@/modules/auth";
import { currentRequestMeta, finish } from "@/modules/tenancy";
import type { ActionResult } from "@/platform/errors";
import type { FormState } from "@/platform/forms";
import {
  submitAppearancePreview, submitChangeSiteAddress, submitChooseTheme, submitCreateSite, submitDeleteSite, submitSetSiteImage, submitSetSiteStatus, submitUpdateAppearance, submitUpdateSeoSettings,
  submitUpdateSiteSettings,
} from "./site-forms";

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

/** The logo or the favicon (M6-4): `role` is bound by the settings page; the form sends the chosen image's id, or none. */
export async function setSiteImageAction(orgSlug: string, siteSlug: string, role: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitSetSiteImage(await getCurrentActor(), orgSlug, siteSlug, role, formData, await currentRequestMeta()));
}

// M8-1: the appearance editor.

export async function updateAppearanceAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitUpdateAppearance(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}

/** The site's SEO defaults (M8-4). */
export async function updateSeoSettingsAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitUpdateSeoSettings(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}

/** A 15-minute preview of settings that are not saved (ADR 0028). Read-only. */
export async function appearancePreviewAction(orgSlug: string, siteSlug: string, formData: FormData): Promise<ActionResult<{ path: string; expiresAt: string }>> {
  return submitAppearancePreview(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta());
}
