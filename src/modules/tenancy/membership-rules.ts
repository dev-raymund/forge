import { roleHolds } from "./permissions";
import type { RoleKey } from "./schema";

/**
 * The rules for changing who belongs to an organization (plan §13,
 * "Invariants"). Pure decisions over roles: the services load the facts under
 * a lock and act on the answer.
 *
 *  1. An organization always has at least one Owner.
 *  2. Only an Owner can make someone an Owner, or change or remove an Owner.
 *  3. Managing other members takes `org.members.manage`; handing the
 *     organization over takes `org.manage`.
 *  4. Anyone can leave, unless that would break rule 1.
 *
 * Rule 3 is a permission: which roles hold it is the catalog's answer
 * (./permissions.ts), asked here about the role the member has NOW, re-read
 * under the lock. Rules 1, 2 and 4 are not permissions and no catalog change
 * can relax them: they say which states an organization may be in, whoever is
 * asking. Rule 2 names the Owner role on purpose.
 */

export type Refusal =
  /** Inside the organization, but not allowed to do this (HTTP 403). */
  | "forbidden"
  /** It would leave the organization without an Owner (HTTP 409). */
  | "last-owner";

export type Decision = { ok: true } | { ok: false; reason: Refusal };

const OK: Decision = { ok: true };
const no = (reason: Refusal): Decision => ({ ok: false, reason });

/** Rule 2: the one role that may make, change or remove an Owner. */
const isOwner = (role: RoleKey) => role === "owner";
/** For code of this module that has to tell an Owner's row from the others (the members page). */
export const isOwnerRole = isOwner;

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
  if (!roleHolds(actorRole, "org.members.manage")) return no("forbidden");
  // Rule 2, in both directions: granting Owner, and touching an Owner.
  if ((isOwner(newRole) || isOwner(currentRole)) && !isOwner(actorRole)) return no("forbidden");
  if (isOwner(currentRole) && !isOwner(newRole) && owners <= 1) return no("last-owner");
  return OK;
}

export type Removal = { actorRole: RoleKey; self: boolean; targetRole: RoleKey; owners: number };

/** Removing a member, or (with `self`) leaving. */
export function decideRemoval({ actorRole, self, targetRole, owners }: Removal): Decision {
  if (!self) {
    if (!roleHolds(actorRole, "org.members.manage")) return no("forbidden");
    if (isOwner(targetRole) && !isOwner(actorRole)) return no("forbidden");
  }
  if (isOwner(targetRole) && owners <= 1) return no("last-owner");
  return OK;
}

export type Transfer = { actorRole: RoleKey; self: boolean };

/**
 * Handing the organization over: the target becomes an Owner and the actor
 * steps down to Admin, in one transaction. It takes `org.manage`, it makes an
 * Owner so rule 2 applies as well, and it cannot be to oneself. It can never
 * break rule 1: there is an Owner before and after.
 */
export function decideTransfer({ actorRole, self }: Transfer): Decision {
  if (!roleHolds(actorRole, "org.manage")) return no("forbidden");
  if (!isOwner(actorRole) || self) return no("forbidden");
  return OK;
}
