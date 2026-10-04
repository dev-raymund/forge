import type { RoleKey } from "./schema";

/**
 * The rules for changing who belongs to an organization (plan §13,
 * "Invariants"). Pure decisions over roles: the services load the facts under
 * a lock and act on the answer.
 *
 *  1. An organization always has at least one Owner.
 *  2. Only an Owner can make someone an Owner, or change or remove an Owner.
 *  3. Managing other members takes an Owner or an Admin.
 *  4. Anyone can leave, unless that would break rule 1.
 *
 * Rule 3 is the `org.members.manage` permission of the catalog (M3-2). It is
 * stated here because without it rule 2 would be all that stands between a
 * Viewer and everybody else's role.
 */

export type Refusal =
  /** Inside the organization, but not allowed to do this (HTTP 403). */
  | "forbidden"
  /** It would leave the organization without an Owner (HTTP 409). */
  | "last-owner";

export type Decision = { ok: true } | { ok: false; reason: Refusal };

const OK: Decision = { ok: true };
const no = (reason: Refusal): Decision => ({ ok: false, reason });

/** Roles that may manage other members. */
export const MEMBER_MANAGERS: readonly RoleKey[] = ["owner", "admin"];
export const canManageMembers = (role: RoleKey) => MEMBER_MANAGERS.includes(role);
/** Renaming, re-addressing and handing over the organization (`org.manage`): Owners. */
export const canManageOrganization = (role: RoleKey) => role === "owner";

export type RoleChange = {
  actorRole: RoleKey;
  /** The member being changed is the actor. */
  self: boolean;
  currentRole: RoleKey;
  newRole: RoleKey;
  /** Owners in the organization right now, counted under the lock. */
  owners: number;
};

export function decideRoleChange({ actorRole, currentRole, newRole, owners }: RoleChange): Decision {
  if (!canManageMembers(actorRole)) return no("forbidden");
  // Rule 2, in both directions: granting Owner, and touching an Owner.
  if ((newRole === "owner" || currentRole === "owner") && actorRole !== "owner") return no("forbidden");
  if (currentRole === "owner" && newRole !== "owner" && owners <= 1) return no("last-owner");
  return OK;
}

export type Removal = { actorRole: RoleKey; self: boolean; targetRole: RoleKey; owners: number };

/** Removing a member, or (with `self`) leaving. */
export function decideRemoval({ actorRole, self, targetRole, owners }: Removal): Decision {
  if (!self) {
    if (!canManageMembers(actorRole)) return no("forbidden");
    if (targetRole === "owner" && actorRole !== "owner") return no("forbidden");
  }
  if (targetRole === "owner" && owners <= 1) return no("last-owner");
  return OK;
}

export type Transfer = { actorRole: RoleKey; self: boolean };

/**
 * Handing the organization over: the target becomes an Owner and the actor
 * steps down to Admin, in one transaction. Only an Owner can, and not to
 * themselves. It can never break rule 1: there is an Owner before and after.
 */
export function decideTransfer({ actorRole, self }: Transfer): Decision {
  if (actorRole !== "owner" || self) return no("forbidden");
  return OK;
}
