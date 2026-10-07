"use server";

import { getCurrentActor } from "@/modules/auth";
import type { FormState } from "@/platform/forms";
import { finish } from "./action-support";
import { currentRequestMeta } from "./context";
import {
  submitAcceptInvitation, submitChangeMemberRole, submitInviteMember, submitLeaveOrganization, submitRemoveMember, submitResendInvitation,
  submitRevokeInvitation,
} from "./member-forms";
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

// ── Members and invitations (M3-4): ./member-forms.ts ───────────────────────

export async function inviteMemberAction(orgSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitInviteMember(await getCurrentActor(), orgSlug, formData, await currentRequestMeta()));
}

export async function resendInvitationAction(orgSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitResendInvitation(await getCurrentActor(), orgSlug, formData, await currentRequestMeta()));
}

export async function revokeInvitationAction(orgSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitRevokeInvitation(await getCurrentActor(), orgSlug, formData, await currentRequestMeta()));
}

export async function changeMemberRoleAction(orgSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitChangeMemberRole(await getCurrentActor(), orgSlug, formData, await currentRequestMeta()));
}

export async function removeMemberAction(orgSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitRemoveMember(await getCurrentActor(), orgSlug, formData, await currentRequestMeta()));
}

export async function leaveOrganizationAction(orgSlug: string, _previous: FormState, formData: FormData): Promise<FormState> {
  return finish(await submitLeaveOrganization(await getCurrentActor(), orgSlug, formData, await currentRequestMeta()));
}

/** `token` is bound by the invitation page from its own URL. It is the secret itself: never logged, never echoed. */
export async function acceptInvitationAction(token: string): Promise<FormState> {
  return finish(await submitAcceptInvitation(await getCurrentActor(), token, await currentRequestMeta()));
}
