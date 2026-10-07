import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PlatformTx, TenantTx } from "@/platform/db";
// Another module's table (the inviter's and a member's name and address) comes from the schema barrel.
import { users } from "@/platform/db/schema";
import { organizationInvitations, organizationMembers, organizations, ROLE_KEYS, roles, type RoleKey } from "./schema";

/**
 * Queries for invitations. Like ./repository.ts, each takes the transaction it
 * runs in: the tenant context that RLS reads is the caller's decision. Every
 * query names the organization as well, so a row of another organization is
 * not found even where a policy alone would show it.
 */

const isRoleKey = (key: string): key is RoleKey => (ROLE_KEYS as readonly string[]).includes(key);
/** Only the five system roles mean anything (see ./repository.ts). */
const systemRole = and(eq(roles.id, organizationInvitations.roleId), isNull(roles.organizationId));
const open = and(isNull(organizationInvitations.acceptedAt), isNull(organizationInvitations.revokedAt));

export type InvitationRow = {
  id: string;
  email: string;
  role: RoleKey;
  roleId: string;
  tokenHash: string;
  invitedBy: string | null;
  inviterName: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

const columns = {
  id: organizationInvitations.id,
  email: organizationInvitations.email,
  roleKey: roles.key,
  roleId: organizationInvitations.roleId,
  tokenHash: organizationInvitations.tokenHash,
  invitedBy: organizationInvitations.invitedBy,
  inviterName: users.name,
  expiresAt: organizationInvitations.expiresAt,
  acceptedAt: organizationInvitations.acceptedAt,
  revokedAt: organizationInvitations.revokedAt,
  createdAt: organizationInvitations.createdAt,
};

function toInvitation({ roleKey, ...row }: Omit<InvitationRow, "role"> & { roleKey: string }): InvitationRow | null {
  return isRoleKey(roleKey) ? { ...row, role: roleKey } : null;
}

const selectInvitations = (tx: TenantTx) =>
  tx.select(columns).from(organizationInvitations).innerJoin(roles, systemRole).leftJoin(users, eq(users.id, organizationInvitations.invitedBy));

/** The invitations still on the organization's list: neither accepted nor revoked. Expired ones included. Newest first. */
export async function listOpenInvitations(tx: TenantTx, organizationId: string): Promise<InvitationRow[]> {
  const rows = await selectInvitations(tx)
    .where(and(eq(organizationInvitations.organizationId, organizationId), open))
    .orderBy(sql`${organizationInvitations.createdAt} desc`, sql`${organizationInvitations.id} desc`);
  return rows.map(toInvitation).filter((row): row is InvitationRow => row !== null);
}

/** One invitation of THIS organization, whatever its state. */
export async function findInvitation(tx: TenantTx, organizationId: string, invitationId: string): Promise<InvitationRow | null> {
  const [row] = await selectInvitations(tx).where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.id, invitationId)));
  return row ? toInvitation(row) : null;
}

/** The open invitation for an address, if there is one. At most one can exist (a partial unique index). */
export async function findOpenInvitationByEmail(tx: TenantTx, organizationId: string, email: string): Promise<InvitationRow | null> {
  const [row] = await selectInvitations(tx).where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.email, email), open));
  return row ? toInvitation(row) : null;
}

export async function insertInvitation(
  tx: TenantTx,
  values: { organizationId: string; email: string; roleId: string; tokenHash: string; invitedBy: string; expiresAt: Date },
): Promise<string> {
  const [row] = await tx.insert(organizationInvitations).values(values).returning({ id: organizationInvitations.id });
  return row!.id;
}

/** A new link for the same invitation: the old token's hash is overwritten, so the old link can never match again. */
export async function replaceInvitationToken(tx: TenantTx, organizationId: string, invitationId: string, values: { tokenHash: string; expiresAt: Date }): Promise<void> {
  await tx
    .update(organizationInvitations)
    .set(values)
    .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.id, invitationId), open));
}

export async function markInvitationRevoked(tx: TenantTx, organizationId: string, invitationId: string, at: Date): Promise<void> {
  await tx
    .update(organizationInvitations)
    .set({ revokedAt: at })
    .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.id, invitationId), open));
}

export async function markInvitationAccepted(tx: TenantTx, organizationId: string, invitationId: string, at: Date): Promise<void> {
  await tx
    .update(organizationInvitations)
    .set({ acceptedAt: at })
    .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.id, invitationId), open));
}

// ── Members, as invitations need them ────────────────────────────────────────

/** Is this address already a member of the organization? Addresses are compared in one spelling. */
export async function isMemberEmail(tx: TenantTx, organizationId: string, email: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.organizationId, organizationId), sql`lower(${users.email}) = ${email}`))
    .limit(1);
  return row !== undefined;
}

export async function isMemberUser(tx: TenantTx, organizationId: string, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    .limit(1);
  return row !== undefined;
}

export async function insertMember(tx: TenantTx, values: { organizationId: string; userId: string; roleId: string }): Promise<void> {
  await tx.insert(organizationMembers).values(values);
}

/** The organization an invitation belongs to, read inside that organization's own context. */
export async function findInvitingOrganization(tx: TenantTx, organizationId: string) {
  const [row] = await tx
    .select({ id: organizations.id, slug: organizations.slug, name: organizations.name, status: organizations.status })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)));
  return row ?? null;
}

// ── The token lookup ─────────────────────────────────────────────────────────

export type ResolvedInvitation = { invitationId: string; organizationId: string; email: string; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null };

/**
 * Token hash → which invitation, of which organization. The one place a
 * request with no tenant context learns an organization's id: through
 * `resolve_invitation()`, a SECURITY DEFINER function that answers only for a
 * hash that matches exactly (ADR 0001). It returns the minimum; everything
 * else is read afterwards inside that organization's context.
 */
export async function resolveInvitationToken(tx: PlatformTx, tokenHash: string): Promise<ResolvedInvitation | null> {
  const { rows } = await tx.execute<{
    invitation_id: string; organization_id: string; email: string; expires_at: Date | string; accepted_at: Date | string | null; revoked_at: Date | string | null;
  }>(sql`select invitation_id, organization_id, email, expires_at, accepted_at, revoked_at from resolve_invitation(${tokenHash})`);
  const row = rows[0];
  if (!row) return null;
  const date = (value: Date | string | null) => (value === null ? null : new Date(value));
  return {
    invitationId: row.invitation_id,
    organizationId: row.organization_id,
    email: row.email,
    expiresAt: new Date(row.expires_at),
    acceptedAt: date(row.accepted_at),
    revokedAt: date(row.revoked_at),
  };
}

/** A user's address as the database has it. Identity data: readable without a tenant context. */
export async function findUserEmail(tx: PlatformTx, userId: string): Promise<string | null> {
  const [row] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return row?.email ?? null;
}
