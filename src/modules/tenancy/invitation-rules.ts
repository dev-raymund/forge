import type { RoleKey } from "./schema";

/**
 * The rules of an invitation (plan §3, §19; ADR 0001 addendum M3-4). Pure:
 * no database, no clock of its own.
 *
 *  - It is for one email address and one role, in one organization.
 *  - It can be accepted once, within 7 days, by an account with that address.
 *  - It never makes anyone an Owner. Ownership is handed over on purpose, to
 *    someone who is already a member (the transfer in the settings).
 */

export const INVITATION_DAYS = 7;
const DAY_MS = 24 * 3600 * 1000;

/** When an invitation issued (or re-sent) at `from` stops working. */
export const invitationExpiry = (from: Date): Date => new Date(from.getTime() + INVITATION_DAYS * DAY_MS);

/**
 * The roles a person can be invited with, or moved to from the members page.
 * Owner is not among them: there is no link, and no drop-down, that makes an
 * Owner.
 */
export const ASSIGNABLE_ROLES = ["admin", "editor", "author", "viewer"] as const satisfies readonly RoleKey[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
export const isAssignableRole = (role: unknown): role is AssignableRole => (ASSIGNABLE_ROLES as readonly unknown[]).includes(role);

/**
 * Where an invitation is in its life. The order of the checks is the rule:
 * accepted and revoked are final, and an invitation that was accepted in time
 * does not later become "expired".
 *
 *   pending ──accept──▶ accepted
 *      │ ╲──revoke──▶ revoked
 *      │ time
 *      ▼
 *   expired ──resend──▶ pending   (a new link; the old one never works again)
 *      ╲──revoke──▶ revoked
 */
export type InvitationState = "pending" | "expired" | "accepted" | "revoked";
export type InvitationDates = { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null };

export function invitationState(invitation: InvitationDates, now: Date): InvitationState {
  if (invitation.acceptedAt) return "accepted";
  if (invitation.revokedAt) return "revoked";
  return invitation.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
}

/** Still on the organization's list: it can be re-sent or revoked. */
export const isOpenInvitation = (state: InvitationState): boolean => state === "pending" || state === "expired";
/** The only state a link can be accepted in. */
export const isAcceptable = (state: InvitationState): boolean => state === "pending";

/** One spelling of an address: trimmed and lowercased, as it is stored. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Is the signed-in account the one the invitation was sent to? Both sides come from the database, never from the request. */
export function isInvitedAccount(invitedEmail: string, accountEmail: string | null | undefined): boolean {
  if (typeof accountEmail !== "string" || accountEmail.trim() === "") return false;
  return normalizeEmail(invitedEmail) === normalizeEmail(accountEmail);
}
