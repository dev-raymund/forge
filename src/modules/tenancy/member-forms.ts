import "server-only";
import type { Actor } from "@/modules/auth";
import type { AppErrorKind } from "@/platform/errors";
import { text } from "@/platform/forms";
import { resolveOrgContext, type RequestMeta } from "./context";
import { pagesOf, refusal, type FormOutcome } from "./form-outcome";
import { homePath } from "./home";
import { looksLikeInvitationToken } from "./invitation-token";
import { acceptInvitation, inviteMember, resendInvitation, revokeInvitation } from "./invitations.service";
import { changeMemberRole, leaveOrganization, removeMember } from "./members.service";
import { homeOrganization } from "./organizations.service";
import { invitationPath, orgMembersPath, orgPath } from "./paths";
import { requirePermission } from "./policies";
import { changeMemberRoleSchema, parseInput } from "./validation";

/**
 * What the members page's forms and the invitation page's form do when they
 * are submitted (M3-4). Same shape as ./organization-forms.ts: the session's
 * user and the slug from the page's URL go in, and the Server Action around
 * each adds only the redirect, the invalidation and the email kick.
 *
 * A member or an invitation is named by its own id, from the form. That id is
 * looked up inside the organization the resolver put the caller in, so an id
 * from another organization finds nothing. No organization id, user id, role
 * of the caller or permission is read from a form.
 */

const LAST_OWNER = "You are the only Owner of this organization. Transfer ownership to another member first.";
const MESSAGES = {
  invitationGone: "That invitation is no longer open. Reload the page to see the current list.",
  memberGone: "That person is not a member of this organization. Reload the page to see the current list.",
  resentTooSoon: "This invitation was sent a moment ago. Wait a minute before sending it again.",
  linkInvalid: "This invitation is no longer valid. Ask the person who invited you to send a new one.",
} as const;

/** Runs a form inside the organization the URL names. Inside it, "not found" is about the thing the form named. */
async function inOrganization(
  actor: Actor,
  orgSlug: string,
  meta: RequestMeta,
  values: Record<string, string>,
  inside: Partial<Record<AppErrorKind, string>>,
  run: (ctx: Awaited<ReturnType<typeof resolveOrgContext>>) => Promise<FormOutcome>,
): Promise<FormOutcome> {
  let resolved = false;
  try {
    const ctx = await resolveOrgContext(actor, orgSlug, meta);
    resolved = true;
    return await run(ctx);
  } catch (error) {
    return refusal(error, meta, values, orgMembersPath(orgSlug), resolved ? inside : {});
  }
}

// ── Invitations ──────────────────────────────────────────────────────────────

export async function submitInviteMember(actor: Actor, orgSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { email: text(formData.get("email")), role: text(formData.get("role")) };
  return inOrganization(actor, orgSlug, meta, values, {}, async (ctx) => {
    const invitation = await inviteMember(ctx, values);
    return {
      // The fields are cleared for the next one; the role stays as chosen.
      state: { status: "success", message: `Invitation sent to ${invitation.email}.`, values: { email: "", role: values.role } },
      revalidate: pagesOf(ctx.org.slug),
      emailQueued: true,
    };
  });
}

export async function submitResendInvitation(actor: Actor, orgSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const invitationId = text(formData.get("invitationId"));
  const inside = { NotFound: MESSAGES.invitationGone, RateLimited: MESSAGES.resentTooSoon };
  return inOrganization(actor, orgSlug, meta, {}, inside, async (ctx) => {
    const invitation = await resendInvitation(ctx, { invitationId });
    return { state: { status: "success", message: `Invitation sent again to ${invitation.email}.` }, revalidate: pagesOf(ctx.org.slug), emailQueued: true };
  });
}

export async function submitRevokeInvitation(actor: Actor, orgSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const invitationId = text(formData.get("invitationId"));
  return inOrganization(actor, orgSlug, meta, {}, { NotFound: MESSAGES.invitationGone }, async (ctx) => {
    await revokeInvitation(ctx, { invitationId });
    return { state: { status: "success", message: "The invitation has been revoked." }, revalidate: pagesOf(ctx.org.slug) };
  });
}

/**
 * The invited person accepts, signed in. There is no organization in the URL
 * here: the token is the whole request, and the service works out the rest.
 * Not signed in → the login page, and back to the invitation afterwards.
 */
export async function submitAcceptInvitation(actor: Actor, token: string, meta: RequestMeta = {}): Promise<FormOutcome> {
  try {
    const { organization } = await acceptInvitation(actor, token);
    return { state: { status: "success" }, redirectTo: orgPath(organization.slug), revalidate: pagesOf(organization.slug) };
  } catch (error) {
    // The way back after logging in is the invitation itself, and only if it has the shape of one.
    const next = looksLikeInvitationToken(token) ? invitationPath(token) : "/";
    return refusal(error, meta, {}, next, { NotFound: MESSAGES.linkInvalid });
  }
}

// ── Members ──────────────────────────────────────────────────────────────────

/**
 * Changes a member's role to one of the assignable roles. Making someone an
 * Owner is not a role change on this page: it is the ownership transfer in the
 * settings, with its own confirmation.
 */
export async function submitChangeMemberRole(actor: Actor, orgSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const memberId = text(formData.get("memberId"));
  const values = { role: text(formData.get("role")) };
  return inOrganization(actor, orgSlug, meta, values, { NotFound: MESSAGES.memberGone }, async (ctx) => {
    // Before the input is looked at: someone who may not do this learns nothing from what they sent.
    requirePermission(ctx, "org.members.manage");
    const { role } = parseInput(changeMemberRoleSchema, values);
    await changeMemberRole(ctx, { memberId, role });
    return { state: { status: "success", message: "The role has been changed." }, revalidate: pagesOf(ctx.org.slug) };
  });
}

export async function submitRemoveMember(actor: Actor, orgSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const memberId = text(formData.get("memberId"));
  return inOrganization(actor, orgSlug, meta, {}, { NotFound: MESSAGES.memberGone, Conflict: LAST_OWNER }, async (ctx) => {
    // Removing oneself is leaving, and has its own form and its own words.
    if (memberId === ctx.membership.id) return leave(actor, ctx);
    await removeMember(ctx, { memberId });
    return { state: { status: "success", message: "They have been removed from the organization." }, revalidate: pagesOf(ctx.org.slug) };
  });
}

/** The caller leaves the organization the URL names, and lands where `/` would take them now: another organization of theirs, or onboarding. */
export async function submitLeaveOrganization(actor: Actor, orgSlug: string, _formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  return inOrganization(actor, orgSlug, meta, {}, { Conflict: LAST_OWNER }, (ctx) => leave(actor, ctx));
}

async function leave(actor: Actor, ctx: Awaited<ReturnType<typeof resolveOrgContext>>): Promise<FormOutcome> {
  await leaveOrganization(ctx);
  // The page itself, not `/`: that is a redirect, and a form's answer has to name a page.
  return { state: { status: "success" }, redirectTo: homePath(await homeOrganization(actor)), revalidate: pagesOf(ctx.org.slug) };
}
