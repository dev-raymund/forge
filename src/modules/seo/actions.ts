"use server";

import { getCurrentActor } from "@/modules/auth";
import { currentRequestMeta, finish } from "@/modules/tenancy";
import type { FormState } from "@/platform/forms";
import { submitCreateRedirect, submitDeleteRedirect, submitSetNotFoundPage, submitUpdateRedirect } from "./redirect-forms";

/** The redirects page (M8-5): add, change, turn on or off, delete; and the site's not-found page. */
export async function createRedirectAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitCreateRedirect(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}

export async function updateRedirectAction(orgSlug: string, siteSlug: string, redirectId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitUpdateRedirect(await getCurrentActor(), orgSlug, siteSlug, redirectId, formData, await currentRequestMeta()));
}

export async function deleteRedirectAction(orgSlug: string, siteSlug: string, redirectId: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitDeleteRedirect(await getCurrentActor(), orgSlug, siteSlug, redirectId, formData, await currentRequestMeta()));
}

export async function setNotFoundPageAction(orgSlug: string, siteSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitSetNotFoundPage(await getCurrentActor(), orgSlug, siteSlug, formData, await currentRequestMeta()));
}
