"use server";

import { getCurrentActor } from "@/modules/auth";
import type { FormState } from "@/platform/forms";
import { finish } from "./action-support";
import { currentRequestMeta } from "./context";
import { submitChangeOrganizationSlug, submitCreateOrganization, submitRenameOrganization, submitTransferOwnership } from "./organization-forms";

/**
 * The organization forms' Server Actions (M3-3): session → ./organization-forms.ts → invalidate → redirect or state.
 *
 * `orgSlug` is bound by the page from its own URL. Like any argument of a
 * Server Action it can be forged, and that is fine: it names an organization,
 * it does not grant one. The resolver checks the session's user against that
 * organization's members on every call.
 */

export async function createOrganizationAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitCreateOrganization(await getCurrentActor(), formData, await currentRequestMeta()));
}

export async function renameOrganizationAction(orgSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitRenameOrganization(await getCurrentActor(), orgSlug, formData, await currentRequestMeta()));
}

export async function changeOrganizationSlugAction(orgSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitChangeOrganizationSlug(await getCurrentActor(), orgSlug, formData, await currentRequestMeta()));
}

export async function transferOwnershipAction(orgSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitTransferOwnership(await getCurrentActor(), orgSlug, formData, await currentRequestMeta()));
}
