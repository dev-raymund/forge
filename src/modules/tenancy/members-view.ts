import type { OrgContext } from "./context";
import { ASSIGNABLE_ROLES } from "./invitation-rules";
import { decideRemoval, decideRoleChange, isOwnerRole } from "./membership-rules";
import { roleHolds } from "./permissions";
import type { RoleKey } from "./schema";
import type { MemberSummary } from "./shared";

/**
 * What the members page may offer, for the member looking at it (M3-4).
 *
 * The page shows a control only where the same rules the services apply would
 * allow the action (./membership-rules.ts, ./permissions.ts), so nobody is
 * offered a button that can only answer "no". It is a courtesy: each action
 * decides again, under the organization lock, from what is true then.
 *
 * Pure: the viewer and the member list go in, booleans come out. The page
 * hands those booleans to its components, and never a role to compare.
 */

export type MembersViewer = { membershipId: string; role: RoleKey; emailVerified: boolean };

export type MemberRow = MemberSummary & {
  isSelf: boolean;
  /** Shown differently: ownership is not a role to pick from a list. */
  isOwner: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
};

export type MembersView = {
  members: MemberRow[];
  /** May change who is in the organization: sees pending invitations and the controls. */
  canManage: boolean;
  /** May send an invitation now. Managing takes the permission; inviting also takes a verified email (plan §12). */
  canInvite: boolean;
  /** Would be allowed to invite, once their own email is verified. */
  mustVerifyEmail: boolean;
  /** Why the viewer cannot leave, when they cannot. */
  leaveBlocked: "last-owner" | null;
};

export function describeMembers(viewer: MembersViewer, members: readonly MemberSummary[]): MembersView {
  const owners = members.filter((member) => isOwnerRole(member.role)).length;
  const canManage = roleHolds(viewer.role, "org.members.manage");

  const rows = members.map((member): MemberRow => {
    const isSelf = member.id === viewer.membershipId;
    const isOwner = isOwnerRole(member.role);
    const facts = { actorRole: viewer.role, self: false, owners };
    return {
      ...member,
      isSelf,
      isOwner,
      // Not for oneself (leaving, or asking someone else, is how one's own role changes), and not for an
      // Owner: ownership is handed over in the settings, not picked from the list of roles.
      canChangeRole:
        !isSelf && !isOwner && ASSIGNABLE_ROLES.some((role) => role !== member.role && decideRoleChange({ ...facts, currentRole: member.role, newRole: role }).ok),
      canRemove: !isSelf && decideRemoval({ ...facts, targetRole: member.role }).ok,
    };
  });

  const leaving = decideRemoval({ actorRole: viewer.role, self: true, targetRole: viewer.role, owners });
  return {
    members: rows,
    canManage,
    canInvite: canManage && viewer.emailVerified,
    mustVerifyEmail: canManage && !viewer.emailVerified,
    leaveBlocked: leaving.ok ? null : "last-owner",
  };
}

/** The same, for the member a context belongs to. */
export const membersViewFor = (ctx: OrgContext, members: readonly MemberSummary[]): MembersView =>
  describeMembers({ membershipId: ctx.membership.id, role: ctx.membership.role, emailVerified: ctx.actor.emailVerified }, members);
