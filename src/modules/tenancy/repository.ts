import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx, Tx, UserTx } from "@/platform/db";
// Another module's table (a join on the member's name and address) comes from the schema barrel.
import { users } from "@/platform/db/schema";
import { organizationMembers, organizations, ROLE_KEYS, roles, type RoleKey } from "./schema";
import type { MemberSummary, OrganizationSummary } from "./shared";

/**
 * Queries of the tenancy module. Each takes the transaction it runs in, so the
 * tenant (or user) context that RLS reads is decided by the caller: a service
 * holding a verified context, never by these functions.
 */

const isRoleKey = (key: string): key is RoleKey => (ROLE_KEYS as readonly string[]).includes(key);

/** The five system roles are reference data with fixed ids (migration 0002): read once per process. */
let systemRoleIds: Map<RoleKey, string> | undefined;

export async function roleIdFor(tx: Tx, key: RoleKey): Promise<string> {
  if (!systemRoleIds) {
    const rows = await tx.select({ id: roles.id, key: roles.key }).from(roles).where(isNull(roles.organizationId));
    systemRoleIds = new Map(rows.filter((row) => isRoleKey(row.key)).map((row) => [row.key as RoleKey, row.id]));
  }
  const id = systemRoleIds.get(key);
  if (!id) throw new Error(`system role "${key}" is missing (seeded by migration 0002)`);
  return id;
}

const membershipColumns = {
  id: organizations.id,
  slug: organizations.slug,
  name: organizations.name,
  status: organizations.status,
  membershipId: organizationMembers.id,
  roleKey: roles.key,
};

export type MembershipRow = OrganizationSummary & { membershipId: string };

/** A role key this code does not know holds nothing (plan §13): the membership is treated as absent. */
function toMembership(row: { id: string; slug: string; name: string; status: OrganizationSummary["status"]; membershipId: string; roleKey: string }): MembershipRow | null {
  if (!isRoleKey(row.roleKey)) return null;
  return { id: row.id, slug: row.slug, name: row.name, status: row.status, role: row.roleKey, membershipId: row.membershipId };
}

/**
 * The user's membership of the organization with this slug, or null: unknown
 * slug, deleted organization and "not a member" are one answer. Runs under the
 * user's own context: RLS shows a user only organizations they belong to.
 */
export async function findMembershipBySlug(tx: UserTx, userId: string, slug: string): Promise<MembershipRow | null> {
  const [row] = await tx
    .select(membershipColumns)
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
    .where(and(eq(organizationMembers.userId, userId), eq(organizations.slug, slug), isNull(organizations.deletedAt)));
  return row ? toMembership(row) : null;
}

/** Every organization the user belongs to, by name. */
export async function listMemberships(tx: UserTx, userId: string): Promise<MembershipRow[]> {
  const rows = await tx
    .select(membershipColumns)
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
    .where(and(eq(organizationMembers.userId, userId), isNull(organizations.deletedAt)))
    .orderBy(organizations.name, organizations.id);
  return rows.map(toMembership).filter((row): row is MembershipRow => row !== null);
}

/**
 * Serialises membership changes in one organization. Every change that could
 * affect the last-Owner rule takes this lock first, then reads, then decides:
 * two Owners demoting each other at the same moment cannot both succeed.
 */
export async function lockOrganization(tx: TenantTx, organizationId: string): Promise<void> {
  await tx.execute(sql`select 1 from ${organizations} where ${organizations.id} = ${organizationId} for update`);
}

export type MemberRow = { id: string; userId: string; role: RoleKey };

/**
 * One membership of THIS organization. The organization is in the WHERE clause
 * on purpose: the read policy also shows a user their own memberships of other
 * organizations, and those must never be reachable from here.
 */
export async function findMember(tx: TenantTx, organizationId: string, memberId: string): Promise<MemberRow | null> {
  const [row] = await tx
    .select({ id: organizationMembers.id, userId: organizationMembers.userId, roleKey: roles.key })
    .from(organizationMembers)
    .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.id, memberId)));
  return row && isRoleKey(row.roleKey) ? { id: row.id, userId: row.userId, role: row.roleKey } : null;
}

export async function countOwners(tx: TenantTx, organizationId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.roleId, await roleIdFor(tx, "owner"))));
  return row?.n ?? 0;
}

export async function listMembers(tx: TenantTx, organizationId: string): Promise<MemberSummary[]> {
  const rows = await tx
    .select({
      id: organizationMembers.id,
      userId: organizationMembers.userId,
      name: users.name,
      email: users.email,
      roleKey: roles.key,
      joinedAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
    .where(eq(organizationMembers.organizationId, organizationId))
    .orderBy(organizationMembers.createdAt, organizationMembers.id);
  return rows.filter((row) => isRoleKey(row.roleKey)).map(({ roleKey, ...row }) => ({ ...row, role: roleKey as RoleKey }));
}

export async function setMemberRole(tx: TenantTx, organizationId: string, memberId: string, role: RoleKey): Promise<void> {
  await tx
    .update(organizationMembers)
    .set({ roleId: await roleIdFor(tx, role) })
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.id, memberId)));
}

export async function deleteMember(tx: TenantTx, organizationId: string, memberId: string): Promise<void> {
  await tx.delete(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.id, memberId)));
}
