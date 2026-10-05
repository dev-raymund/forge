import "server-only";
import { forbidden } from "@/platform/errors";
import { assertContext, isContext, type OrgContext } from "./context";
import { permits, type OwnedResource, type OwnScope, type Permission } from "./permissions";

/**
 * Authorization: what a member may do in the organization the resolver put
 * them in (plan §13, D-09, ADR 0009). Three separate layers answer three
 * separate questions, and none stands in for another:
 *
 *   RBAC      (./permissions.ts)   what does this role hold?            role → permissions
 *   policies  (here)               may this caller attempt this?        can(ctx, permission, resource?)
 *   RLS       (Postgres)           is this row in the caller's tenant?  whatever the code above did
 *
 * A policy says whether the caller may ATTEMPT something. Whether the result
 * would be valid (an organization keeps an Owner; a plan's limit is not
 * exceeded) is the service's business rule or an entitlement, checked after.
 *
 * The order in a service: authenticate → resolve the tenant → policy →
 * entitlement → validate input → business rules. Outside the tenant the answer
 * is `NotFound` (the resolver, and lookups scoped to `ctx.org.id`); inside it
 * without the permission, `Forbidden`.
 */

/**
 * May the caller do this? A plain yes or no: it never throws.
 *
 * - The answer comes from the permissions the resolver put in the context.
 *   Nothing the request carries (a body field, a header, a cookie) is read.
 * - Something that is not a context the resolver returned is allowed nothing.
 * - A key that is not in the catalog is held by nobody.
 * - A `.own` key needs the `resource`, and it must be the caller's own. A
 *   resource of another organization is refused whatever the key.
 */
export function can(ctx: OrgContext, permission: Permission, resource?: OwnedResource | null): boolean {
  if (!isContext(ctx)) return false;
  return permits({ permissions: ctx.permissions, userId: ctx.actor.userId, organizationId: ctx.org.id }, permission, resource);
}

/**
 * The same check for a service: returns when allowed, throws `Forbidden` (403)
 * when not. Called before anything is read or locked on the caller's behalf.
 */
export function requirePermission(ctx: OrgContext, permission: Permission, resource?: OwnedResource | null): void {
  assertContext(ctx);
  if (!can(ctx, permission, resource)) throw forbidden();
}

/**
 * "Anyone's, or their own": `canActOn(ctx, "media.delete", item)` is true with
 * `media.delete.any`, or with `media.delete.own` when the caller uploaded it.
 * What the content and media policies are written with:
 *
 *   canDeleteMedia = (ctx, m) => canActOn(ctx, "media.delete", { organizationId: m.organizationId, ownerId: m.uploadedBy })
 */
export function canActOn(ctx: OrgContext, scope: OwnScope, resource: OwnedResource): boolean {
  return can(ctx, `${scope}.any`, resource) || can(ctx, `${scope}.own`, resource);
}

// ── The tenancy module's own policies ────────────────────────────────────────
// What each operation of this module takes. Reading the organization and its
// member list takes membership and nothing more, so there is no policy for it.

/** Rename the organization or change its slug. */
export const canUpdateOrganization = (ctx: OrgContext): boolean => can(ctx, "org.manage");

/**
 * Hand the organization to another member. The permission is the attempt; that
 * only an Owner can make an Owner is a rule of its own (./membership-rules.ts).
 */
export const canTransferOwnership = (ctx: OrgContext): boolean => can(ctx, "org.manage");

/**
 * Change another member's role, or remove them. Which members an Admin may not
 * touch (Owners), and that one Owner always remains, are the membership rules.
 */
export const canManageMembers = (ctx: OrgContext): boolean => can(ctx, "org.members.manage");
