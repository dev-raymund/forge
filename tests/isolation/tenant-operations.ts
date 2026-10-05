import type { Actor } from "@/modules/auth/shared";
import {
  can, canActOn, changeMemberRole, listMembers, PERMISSIONS, removeMember, resolveOrgContext, resolveSiteContext, transferOwnership, updateOrganization,
  type OrgContext, type OwnedResource, type OwnScope, type Permission,
} from "@/modules/tenancy";

/**
 * Registry of operations that take an identifier from the caller, for the
 * "another tenant's ids → 404" check of the isolation suite (M1-6, activated
 * in M3-1 now that there is something to call).
 *
 * The suite runs every entry as a member of organization A, handing it
 * identifiers that belong to organization B, and requires:
 *   1. the operation is refused with `NotFound` (never `Forbidden`, which would
 *      confirm that the thing exists), and
 *   2. nothing of B's changed.
 *
 * Register every new service, Server Action and route handler that accepts an
 * id or a slug here. An action or a handler is registered through the function
 * it calls, with the context it would resolve; when action wrappers exist
 * (M3-3) they can be registered directly, returning their `ActionResult`.
 *
 * Since M3-2 the suite also runs every entry as a member of A who holds no
 * permission to manage anything (a Viewer). There the requirement is that the
 * answer for B's identifiers is the same as for identifiers that exist nowhere:
 * `Forbidden` is fine, as long as it is `Forbidden` for both.
 *
 * A policy that is handed a resource (a row someone already loaded) goes in
 * `tenantPolicyChecks` below.
 */

/** Who is asking: a user who belongs to A (as an Owner, so permission is never the reason for a refusal). */
export type Caller = { actor: Actor; ctx: OrgContext; orgSlug: string };

/** Identifiers that belong to the other organization. */
export type Foreign = {
  orgId: string;
  orgSlug: string;
  siteId: string;
  siteSlug: string;
  /** A membership row of B (its Owner's). */
  memberId: string;
  userId: string;
};

export type TenantOperation = {
  name: string;
  /** Must reject with an `AppError` of kind `NotFound`. */
  run: (caller: Caller, foreign: Foreign) => Promise<unknown>;
};

export const tenantOperations: TenantOperation[] = [
  // The resolver: every admin request starts here.
  { name: "tenancy.resolveOrgContext(B's slug)", run: ({ actor }, b) => resolveOrgContext(actor, b.orgSlug) },
  { name: "tenancy.resolveSiteContext(A's org, B's site slug)", run: ({ actor, orgSlug }, b) => resolveSiteContext(actor, orgSlug, b.siteSlug) },
  { name: "tenancy.resolveSiteContext(B's org, B's site)", run: ({ actor }, b) => resolveSiteContext(actor, b.orgSlug, b.siteSlug) },
  { name: "tenancy.resolveSiteContext(A's org, B's site id as the slug)", run: ({ actor, orgSlug }, b) => resolveSiteContext(actor, orgSlug, b.siteId) },

  // Members: named by membership id.
  { name: "tenancy.changeMemberRole(B's member)", run: ({ ctx }, b) => changeMemberRole(ctx, { memberId: b.memberId, role: "viewer" }) },
  { name: "tenancy.removeMember(B's member)", run: ({ ctx }, b) => removeMember(ctx, { memberId: b.memberId }) },
  { name: "tenancy.transferOwnership(B's member)", run: ({ ctx }, b) => transferOwnership(ctx, { memberId: b.memberId }) },
  { name: "tenancy.changeMemberRole(B's user id as the member id)", run: ({ ctx }, b) => changeMemberRole(ctx, { memberId: b.userId, role: "owner" }) },
  { name: "tenancy.removeMember(B's organization id as the member id)", run: ({ ctx }, b) => removeMember(ctx, { memberId: b.orgId }) },
];

/**
 * Operations that take no identifier at all: their target is the caller's own
 * context. Handing them B's ids in extra fields must leave B untouched, and
 * they must still succeed on A (so the test is not passing by refusing everything).
 */
export const contextBoundOperations: { name: string; run: (caller: Caller, foreign: Foreign) => Promise<unknown> }[] = [
  {
    name: "tenancy.updateOrganization(extra fields naming B)",
    run: ({ ctx }, b) => updateOrganization(ctx, { name: "Still A", id: b.orgId, organizationId: b.orgId, orgSlug: b.orgSlug } as { name: string }),
  },
  { name: "tenancy.listMembers()", run: ({ ctx }) => listMembers(ctx) },
];

/**
 * Permission checks that are handed a resource (M3-2). The suite gives each one
 * a resource that belongs to B and was made by the caller's own user: the case
 * most likely to slip through an "is it theirs?" rule. Each returns the keys it
 * wrongly allowed, and must return none. Register the policy of every later
 * module here (`canUpdateEntry`, `canDeleteMedia`, …).
 */
const OWN_SCOPES: OwnScope[] = ["entries.post.update", "entries.post.publish", "entries.post.delete", "media.update", "media.delete"];

export const tenantPolicyChecks: { name: string; run: (ctx: OrgContext, resource: OwnedResource) => string[] }[] = [
  { name: "tenancy.can(every permission, the resource)", run: (ctx, resource) => PERMISSIONS.filter((key: Permission) => can(ctx, key, resource)) },
  { name: "tenancy.canActOn(every own/any scope, the resource)", run: (ctx, resource) => OWN_SCOPES.filter((scope) => canActOn(ctx, scope, resource)) },
];
