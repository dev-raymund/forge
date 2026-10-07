import "server-only";
import type { Actor } from "@/modules/auth";
import { env } from "@/platform/config/env";
import { isUniqueViolation, withPlatform, withTenant, type TenantTx } from "@/platform/db";
import { queueEmail } from "@/platform/email";
import { conflict, forbidden, notFound, rateLimited, unauthenticated, validationError } from "@/platform/errors";
import { inTenant, type OrgContext } from "./context";
import {
  INVITATION_DAYS, invitationExpiry, invitationState, isAcceptable, isAssignableRole, isInvitedAccount, isOpenInvitation, type AssignableRole,
} from "./invitation-rules";
import { hashInvitationToken, looksLikeInvitationToken, newInvitationToken } from "./invitation-token";
import {
  findInvitation, findInvitingOrganization, findOpenInvitationByEmail, findUserEmail, insertInvitation, insertMember, isMemberEmail, isMemberUser,
  listOpenInvitations, markInvitationAccepted, markInvitationRevoked, replaceInvitationToken, resolveInvitationToken, type InvitationRow,
} from "./invitations.repository";
import { invitationPath } from "./paths";
import { roleHolds } from "./permissions";
import { requirePermission } from "./policies";
import { findMember, lockOrganization, roleIdFor } from "./repository";
import type { RoleKey } from "./schema";
import { inviteMemberSchema, parseInput } from "./validation";

/**
 * Invitations (plan §3, M3-4): ask someone to join by email, and let them in
 * when they come.
 *
 * Two different kinds of caller:
 *
 *  - A member managing the organization's invitations. They have a context
 *    from the resolver, need `org.members.manage`, and every change takes the
 *    organization lock, like every other change to who belongs.
 *  - The person invited. They are not a member and have no context. What they
 *    hold is the link. The token in it is looked up through
 *    `resolve_invitation()`, and what follows runs inside the organization that
 *    function named, and nowhere else.
 *
 * The token is made here, put in the email's link, and forgotten: the table
 * has its hash. A link can therefore be sent, but never shown again.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The partial unique index: one open invitation per address in an organization. */
const ONE_OPEN_PER_EMAIL = "organization_invitations_open_email_unique";
/** How soon the same invitation may be sent again. */
const RESEND_AFTER_SECONDS = 60;

const MESSAGES = {
  unverified: "Verify your email address before inviting people.",
  alreadyMember: "That person is already a member of this organization.",
  alreadyInvited: "There is already an invitation for this address. You can send it again or revoke it.",
  wrongAccount: "This invitation was sent to a different email address. Log in with that address to accept it.",
  expired: "This invitation has expired. Ask the person who invited you to send a new one.",
} as const;

export type InvitationSummary = {
  id: string;
  email: string;
  role: RoleKey;
  invitedByName: string | null;
  createdAt: Date;
  expiresAt: Date;
  /** Past its date and not yet re-sent or revoked. */
  expired: boolean;
};

const toSummary = (row: Pick<InvitationRow, "id" | "email" | "role" | "inviterName" | "createdAt" | "expiresAt" | "acceptedAt" | "revokedAt">, now: Date): InvitationSummary => ({
  id: row.id,
  email: row.email,
  role: row.role,
  invitedByName: row.inviterName,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  expired: invitationState(row, now) === "expired",
});

/** The link that goes in the email. Built from the app's own origin: the email job refuses any other. */
const invitationUrl = (token: string) => `${env("core").APP_ORIGIN.replace(/\/$/, "")}${invitationPath(token)}`;

/** Takes the organization lock and asks the permission again, of the role the caller has now. */
async function lockAsManager(tx: TenantTx, ctx: OrgContext): Promise<void> {
  await lockOrganization(tx, ctx.org.id);
  const actor = await findMember(tx, ctx.org.id, ctx.membership.id);
  if (!actor) throw notFound(); // removed since the request began
  if (!roleHolds(actor.role, "org.members.manage")) throw forbidden();
}

// ── Managing invitations (a member, with a context) ──────────────────────────

/** The invitations waiting for an answer, expired ones included. For those who manage members. */
export async function listInvitations(ctx: OrgContext): Promise<InvitationSummary[]> {
  requirePermission(ctx, "org.members.manage");
  const now = new Date();
  const rows = await inTenant(ctx, (tx) => listOpenInvitations(tx, ctx.org.id));
  return rows.map((row) => toSummary(row, now));
}

/**
 * Invites an address to the organization with a role, and queues the email in
 * the same transaction: there is an invitation if and only if its email is on
 * its way.
 *
 * - Takes `org.members.manage`, and a verified email of the inviter's own (plan §12).
 * - The role is one of the assignable ones. Nobody is invited as an Owner.
 * - Someone who is already a member is not invited. An address with an
 *   invitation still pending is not invited twice: re-send that one. An
 *   invitation that expired unused gives way to the new one.
 *
 * Returns after the commit; the caller (a Server Action) kicks the email job.
 */
export async function inviteMember(ctx: OrgContext, input: { email: string; role: string }): Promise<InvitationSummary> {
  requirePermission(ctx, "org.members.manage");
  if (!ctx.actor.emailVerified) throw forbidden(MESSAGES.unverified);
  const { email, role } = parseInput(inviteMemberSchema, input);
  const now = new Date();
  const { token, tokenHash } = newInvitationToken();
  const expiresAt = invitationExpiry(now);

  try {
    return await inTenant(ctx, async (tx) => {
      await lockAsManager(tx, ctx);
      if (await isMemberEmail(tx, ctx.org.id, email)) throw validationError({ email: [MESSAGES.alreadyMember] });
      const earlier = await findOpenInvitationByEmail(tx, ctx.org.id, email);
      if (earlier) {
        if (invitationState(earlier, now) === "pending") throw validationError({ email: [MESSAGES.alreadyInvited] });
        await markInvitationRevoked(tx, ctx.org.id, earlier.id, now);
      }
      const id = await insertInvitation(tx, {
        organizationId: ctx.org.id, email, roleId: await roleIdFor(tx, role), tokenHash, invitedBy: ctx.actor.userId, expiresAt,
      });
      await queueEmail(tx, { template: "organization-invitation", invitationId: id, url: invitationUrl(token) });
      const created = await findInvitation(tx, ctx.org.id, id);
      return toSummary(created!, now);
    });
  } catch (error) {
    if (isUniqueViolation(error, ONE_OPEN_PER_EMAIL)) throw validationError({ email: [MESSAGES.alreadyInvited] });
    throw error;
  }
}

/**
 * Sends an open invitation again, as a new link good for another 7 days. The
 * link sent before stops working: its hash is replaced, not added to.
 */
export async function resendInvitation(ctx: OrgContext, input: { invitationId: string }): Promise<InvitationSummary> {
  requirePermission(ctx, "org.members.manage");
  if (!ctx.actor.emailVerified) throw forbidden(MESSAGES.unverified);
  if (typeof input.invitationId !== "string" || !UUID.test(input.invitationId)) throw notFound();
  const now = new Date();
  const { token, tokenHash } = newInvitationToken();

  return inTenant(ctx, async (tx) => {
    await lockAsManager(tx, ctx);
    const invitation = await findInvitation(tx, ctx.org.id, input.invitationId);
    if (!invitation || !isOpenInvitation(invitationState(invitation, now))) throw notFound();
    // When it was last sent is its expiry minus the 7 days it was given then.
    const sentAt = invitation.expiresAt.getTime() - INVITATION_DAYS * 24 * 3600 * 1000;
    const wait = Math.ceil((sentAt + RESEND_AFTER_SECONDS * 1000 - now.getTime()) / 1000);
    if (wait > 0) throw rateLimited(wait);
    if (await isMemberEmail(tx, ctx.org.id, invitation.email)) throw conflict(MESSAGES.alreadyMember);

    const expiresAt = invitationExpiry(now);
    await replaceInvitationToken(tx, ctx.org.id, invitation.id, { tokenHash, expiresAt });
    await queueEmail(tx, { template: "organization-invitation", invitationId: invitation.id, url: invitationUrl(token) });
    return toSummary({ ...invitation, expiresAt }, now);
  });
}

/** Withdraws an open invitation. Its link stops working at once. */
export async function revokeInvitation(ctx: OrgContext, input: { invitationId: string }): Promise<void> {
  requirePermission(ctx, "org.members.manage");
  if (typeof input.invitationId !== "string" || !UUID.test(input.invitationId)) throw notFound();
  const now = new Date();
  await inTenant(ctx, async (tx) => {
    await lockAsManager(tx, ctx);
    const invitation = await findInvitation(tx, ctx.org.id, input.invitationId);
    if (!invitation || !isOpenInvitation(invitationState(invitation, now))) throw notFound();
    await markInvitationRevoked(tx, ctx.org.id, invitation.id, now);
  });
}

// ── Answering an invitation (the person invited: no context, only the link) ──

/**
 * What the page behind an invitation link shows. Anything about the
 * organization is given only for a link that can still be accepted; every
 * other link gets one of two answers that name nothing.
 */
export type InvitationPreview =
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "open"; email: string; role: AssignableRole; organizationName: string; inviterName: string | null; expiresAt: Date };

export async function previewInvitation(token: string): Promise<InvitationPreview> {
  if (!looksLikeInvitationToken(token)) return { status: "invalid" };
  const tokenHash = hashInvitationToken(token);
  const resolved = await withPlatform((tx) => resolveInvitationToken(tx, tokenHash));
  if (!resolved) return { status: "invalid" };
  const state = invitationState(resolved, new Date());
  if (state === "expired") return { status: "expired" };
  if (!isAcceptable(state)) return { status: "invalid" };

  return withTenant({ orgId: resolved.organizationId }, async (tx): Promise<InvitationPreview> => {
    const organization = await findInvitingOrganization(tx, resolved.organizationId);
    const invitation = await findInvitation(tx, resolved.organizationId, resolved.invitationId);
    if (!organization || organization.status !== "active" || !invitation || !isAssignableRole(invitation.role)) return { status: "invalid" };
    return {
      status: "open",
      email: invitation.email,
      role: invitation.role,
      organizationName: organization.name,
      inviterName: invitation.inviterName,
      expiresAt: invitation.expiresAt,
    };
  });
}

export type AcceptedInvitation = {
  organization: { slug: string; name: string };
  /** False when the caller was already a member: opening their own link twice changes nothing. */
  joined: boolean;
};

/**
 * Accepts an invitation as the signed-in user. The link shows that the caller
 * received it; it does not say who they are. Membership goes to the account
 * whose own address, as the database has it, is the address invited, and to no
 * other account that happens to hold the link.
 *
 * One transaction, under the organization lock: the membership row and the
 * invitation's `accepted_at` are written together, so a link is used once
 * however many times, or from however many tabs, it is submitted.
 */
export async function acceptInvitation(actor: Actor, token: string): Promise<AcceptedInvitation> {
  if (actor.kind !== "user") throw unauthenticated();
  if (!looksLikeInvitationToken(token)) throw notFound();
  const tokenHash = hashInvitationToken(token);
  const { resolved, accountEmail } = await withPlatform(async (tx) => ({
    resolved: await resolveInvitationToken(tx, tokenHash),
    accountEmail: await findUserEmail(tx, actor.userId),
  }));
  if (!resolved) throw notFound();
  const now = new Date();

  return withTenant({ orgId: resolved.organizationId, userId: actor.userId }, async (tx) => {
    await lockOrganization(tx, resolved.organizationId);
    const organization = await findInvitingOrganization(tx, resolved.organizationId);
    const invitation = await findInvitation(tx, resolved.organizationId, resolved.invitationId);
    // Read again under the lock: a re-send in between replaced the link that was opened.
    if (!organization || organization.status !== "active" || !invitation || invitation.tokenHash !== tokenHash) throw notFound();
    if (!isInvitedAccount(invitation.email, accountEmail)) throw forbidden(MESSAGES.wrongAccount);

    const state = invitationState(invitation, now);
    const member = await isMemberUser(tx, organization.id, actor.userId);
    const joinedOrganization = { slug: organization.slug, name: organization.name };
    if (state === "accepted" && member) return { organization: joinedOrganization, joined: false };
    if (state === "expired") throw conflict(MESSAGES.expired);
    if (!isAcceptable(state) || !isAssignableRole(invitation.role)) throw notFound();

    // Already a member some other way: the invitation is used up, and their role stays what it is.
    if (!member) await insertMember(tx, { organizationId: organization.id, userId: actor.userId, roleId: invitation.roleId });
    await markInvitationAccepted(tx, organization.id, invitation.id, now);
    return { organization: joinedOrganization, joined: !member };
  });
}
