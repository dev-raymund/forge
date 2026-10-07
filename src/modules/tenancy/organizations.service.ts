import "server-only";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { record, type AuditRequest } from "@/modules/audit";
import type { Actor } from "@/modules/auth";
import { startTrial } from "@/modules/billing";
import { isUniqueViolation, withTenant, withUser } from "@/platform/db";
import { forbidden, notFound, unauthenticated, validationError } from "@/platform/errors";
import { inTenant, type OrgContext } from "./context";
import { chooseHomeOrganization } from "./home";
import { roleHolds } from "./permissions";
import { requirePermission } from "./policies";
import { findMember, findOrganizationNames, listMemberships, lockOrganization, roleIdFor } from "./repository";
import { organizationMembers, organizations } from "./schema";
import type { OrganizationSummary } from "./shared";
import { createOrganizationSchema, parseInput, updateOrganizationSchema, type CreateOrganizationInput, type UpdateOrganizationInput } from "./validation";

/** Organizations: create one, list mine, rename or re-address one (M3-1). */

const SLUG_TAKEN = "That URL is already taken.";
/** The unique constraint on `organizations.slug`. */
const SLUG_UNIQUE = "organizations_slug_unique";

/**
 * Creates an organization with the caller as its Owner, its trial
 * subscription and the first line of its activity log, in one transaction:
 * all of them exist, or none does. There is never a committed organization
 * without an Owner.
 *
 * The new organization's id is generated here, and the transaction's tenant
 * context is that id: RLS admits the three inserts and nothing else.
 */
export async function createOrganization(actor: Actor, input: CreateOrganizationInput, request: AuditRequest = {}): Promise<OrganizationSummary> {
  if (actor.kind !== "user") throw unauthenticated();
  const { name, slug } = parseInput(createOrganizationSchema, input);
  const id = uuidv7();
  try {
    await withTenant({ orgId: id, userId: actor.userId }, async (tx) => {
      await tx.insert(organizations).values({ id, name, slug, createdBy: actor.userId });
      await tx.insert(organizationMembers).values({ organizationId: id, userId: actor.userId, roleId: await roleIdFor(tx, "owner") });
      await startTrial(tx, id);
      // The first line of the new organization's activity, in the transaction that makes it.
      await record(tx, { action: "organization.created", resourceType: "organization", resourceId: id, metadata: { name, slug } }, request);
    });
  } catch (error) {
    if (isUniqueViolation(error, SLUG_UNIQUE)) throw validationError({ slug: [SLUG_TAKEN] });
    throw error;
  }
  return { id, slug, name, status: "active", role: "owner" };
}

/** The organizations the caller belongs to, with their role in each. Nothing about any other organization. */
export async function listOrganizations(actor: Actor): Promise<OrganizationSummary[]> {
  if (actor.kind !== "user") throw unauthenticated();
  const rows = await withUser(actor.userId, (tx) => listMemberships(tx, actor.userId));
  return rows.map(({ id, slug, name, status, role }) => ({ id, slug, name, status, role }));
}

/**
 * The organization `/` takes the caller to, or null when they have none yet
 * (./home.ts has the rule). Read from the caller's own memberships on every
 * request: no "current organization" is stored anywhere.
 */
export async function homeOrganization(actor: Actor): Promise<OrganizationSummary | null> {
  if (actor.kind !== "user") throw unauthenticated();
  const rows = await withUser(actor.userId, (tx) => listMemberships(tx, actor.userId));
  const chosen = chooseHomeOrganization(rows);
  return chosen ? { id: chosen.id, slug: chosen.slug, name: chosen.name, status: chosen.status, role: chosen.role } : null;
}

/**
 * Renames the organization and/or changes its slug. Takes `org.manage` (plan
 * §13). The organization is the context's: there is no id to pass.
 */
export async function updateOrganization(ctx: OrgContext, input: UpdateOrganizationInput): Promise<OrganizationSummary> {
  requirePermission(ctx, "org.manage");
  const changes = parseInput(updateOrganizationSchema, input);
  try {
    return await inTenant(ctx, async (tx) => {
      await lockOrganization(tx, ctx.org.id);
      // Asked again of the role as it is now, not as it was when the request began.
      const actor = await findMember(tx, ctx.org.id, ctx.membership.id);
      if (!actor) throw notFound();
      if (!roleHolds(actor.role, "org.manage")) throw forbidden();
      const before = await findOrganizationNames(tx, ctx.org.id);
      if (!before) throw notFound();
      const [row] = await tx
        .update(organizations)
        .set({ ...(changes.name !== undefined ? { name: changes.name } : {}), ...(changes.slug !== undefined ? { slug: changes.slug } : {}) })
        .where(eq(organizations.id, ctx.org.id))
        .returning({ id: organizations.id, slug: organizations.slug, name: organizations.name, status: organizations.status });
      if (!row) throw notFound();
      // Recorded only if something is different now: saving the same name again is not an event.
      const renamed = row.name !== before.name ? { previousName: before.name, newName: row.name } : {};
      const moved = row.slug !== before.slug ? { previousSlug: before.slug, newSlug: row.slug } : {};
      if (row.name !== before.name || row.slug !== before.slug) {
        await record(tx, { action: "organization.updated", resourceType: "organization", resourceId: ctx.org.id, metadata: { ...renamed, ...moved } }, ctx);
      }
      return { ...row, role: actor.role };
    });
  } catch (error) {
    if (isUniqueViolation(error, SLUG_UNIQUE)) throw validationError({ slug: [SLUG_TAKEN] });
    throw error;
  }
}
