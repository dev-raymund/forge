"use server";

import { getCurrentActor } from "@/modules/auth";
import { currentRequestMeta, finish } from "@/modules/tenancy";
import type { FormState } from "@/platform/forms";
import { submitChangeSiteAddress, submitCreateSite, submitDeleteSite } from "./site-forms";

/**
 * The site forms' Server Actions (M4-1): session → ./site-forms.ts → invalidate → redirect or state.
 *
 * `orgSlug` and `siteSlug` are bound by the page from its own URL. Like any
 * argument of a Server Action they can be forged, and that is fine: they name
 * an organization and a site, they grant neither. The resolver checks the
 * session's user against that organization's members, and the site against
 * that organization, on every call.
 */

export async function createSiteAction(orgSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitCreateSite(await getCurrentActor(), orgSlug, formData, await currentRequestMeta()));
}

export async function changeSiteAddressAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitChangeSiteAddress(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}

export async function deleteSiteAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitDeleteSite(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}
