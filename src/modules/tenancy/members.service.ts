import "server-only";
import type { TenantTx } from "@/platform/db";
import { conflict, forbidden, notFound, validationError } from "@/platform/errors";
import { inTenant, type OrgContext } from "./context";
import { decideRemoval, decideRoleChange, decideTransfer, type Decision } from "./membership-rules";
import { countOwners, deleteMember, findMember, listMembers as listMemberRows, lockOrganization, setMemberRole, type MemberRow } from "./repository";
import { ROLE_KEYS, type RoleKey } from "./schema";
import type { MemberSummary } from "./shared";

/**
 * Members of an organization: list them, change a role, remove one, leave,
 * hand the organization over (M3-1; invitations and the screens are M3-4).
 *
 * Every change runs in one transaction that first locks the organization,
 * then reads who is who, then applies the rules in ./membership-rules.ts. The
 * member to change is named by membership id and looked up inside the
 * context's organization only: an id from another organization is not found.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LAST_OWNER = "An organization needs at least one Owner. Make someone else an Owner first.";

function enforce(decision: Decision): void {
  if (decision.ok) return;
  throw decision.reason === "last-owner" ? conflict(LAST_OWNER) : forbidden();
}

type Facts = { actor: MemberRow; target: MemberRow; owners: number };

/** Locks the organization, then loads the actor's and the target's memberships as they are now. */
async function factsFor(tx: TenantTx, ctx: OrgContext, memberId: string): Promise<Facts> {
  if (typeof memberId !== "string" || !UUID.test(memberId)) throw notFound();
  await lockOrganization(tx, ctx.org.id);
  const actor = await findMember(tx, ctx.org.id, ctx.membership.id);
  if (!actor) throw notFound(); // removed since the request began: the organization is no longer theirs to see
  const target = memberId === actor.id ? actor : await findMember(tx, ctx.org.id, memberId);
  if (!target) throw notFound(); // not a member of this organization, whatever else the id may be
  return { actor, target, owners: await countOwners(tx, ctx.org.id) };
}

/** Everyone in the organization. Any member may see the list (plan §19: Viewer+ read). */
export async function listMembers(ctx: OrgContext): Promise<MemberSummary[]> {
  return inTenant(ctx, (tx) => listMemberRows(tx, ctx.org.id));
}

export async function changeMemberRole(ctx: OrgContext, input: { memberId: string; role: RoleKey }): Promise<void> {
  if (!(ROLE_KEYS as readonly string[]).includes(input.role)) throw validationError({ role: ["Choose a role."] });
  await inTenant(ctx, async (tx) => {
    const { actor, target, owners } = await factsFor(tx, ctx, input.memberId);
    enforce(decideRoleChange({ actorRole: actor.role, self: actor.id === target.id, currentRole: target.role, newRole: input.role, owners }));
    if (target.role !== input.role) await setMemberRole(tx, ctx.org.id, target.id, input.role);
  });
}

/** Removes another member. To remove yourself, leave. */
export async function removeMember(ctx: OrgContext, input: { memberId: string }): Promise<void> {
  await inTenant(ctx, async (tx) => {
    const { actor, target, owners } = await factsFor(tx, ctx, input.memberId);
    enforce(decideRemoval({ actorRole: actor.role, self: actor.id === target.id, targetRole: target.role, owners }));
    await deleteMember(tx, ctx.org.id, target.id);
  });
}

/** The caller leaves the organization. The last Owner cannot. */
export async function leaveOrganization(ctx: OrgContext): Promise<void> {
  await inTenant(ctx, async (tx) => {
    const { actor, owners } = await factsFor(tx, ctx, ctx.membership.id);
    enforce(decideRemoval({ actorRole: actor.role, self: true, targetRole: actor.role, owners }));
    await deleteMember(tx, ctx.org.id, actor.id);
  });
}

/**
 * Hands the organization to another member: they become an Owner and the
 * caller becomes an Admin, together. An organization may have several Owners,
 * so this is "promote and step down", and at no point is there no Owner.
 */
export async function transferOwnership(ctx: OrgContext, input: { memberId: string }): Promise<void> {
  await inTenant(ctx, async (tx) => {
    const { actor, target } = await factsFor(tx, ctx, input.memberId);
    enforce(decideTransfer({ actorRole: actor.role, self: actor.id === target.id }));
    await setMemberRole(tx, ctx.org.id, target.id, "owner");
    await setMemberRole(tx, ctx.org.id, actor.id, "admin");
  });
}
