import { randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import type { Actor } from "@/modules/auth/shared";
import { createOrganization, resolveOrgContext, type RoleKey } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { isAppError, type AppError } from "@/platform/errors";
import { createUser, roleId } from "./factories";

/**
 * Organizations and members for integration tests, made the way the
 * application makes them: `createOrganization()` for the organization and its
 * Owner, and a tenant context for every membership row. Contexts come from the
 * resolver, as everywhere else.
 */

const unique = () => randomBytes(4).toString("hex");
export const newSlug = (prefix = "org") => `${prefix}-${unique()}`;
export const actorOf = (user: { id: string }): Actor => ({ kind: "user", userId: user.id, sessionId: uuidv7(), emailVerified: true });

/** A user with their own organization, and that user's context in it. */
export async function newTenant(name = "Tenant") {
  const user = await createUser({ name: `${name} Owner` });
  const actor = actorOf(user);
  const org = await createOrganization(actor, { name: `${name} ${unique()}`, slug: newSlug() });
  return { user, actor, org, ctx: await resolveOrgContext(actor, org.slug) };
}

/** Adds an existing user to an organization (what accepting an invitation will do, M3-4). */
export async function addUser(org: { id: string }, user: { id: string }, role: RoleKey) {
  const [member] = await withTenant({ orgId: org.id }, async (tx) =>
    tx.insert(t.organizationMembers).values({ organizationId: org.id, userId: user.id, roleId: await roleId(tx, role) }).returning(),
  );
  return { user, actor: actorOf(user), memberId: member!.id };
}

/** A new user, as a member with this role, and their context. */
export async function addMember(org: { id: string; slug: string }, role: RoleKey) {
  const member = await addUser(org, await createUser({ name: `A ${role}` }), role);
  return { ...member, ctx: await resolveOrgContext(member.actor, org.slug) };
}

/** The `AppError` an operation was refused with. Anything else it threw is rethrown. */
export async function refusalOf(run: () => unknown): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("expected the operation to be refused");
}
