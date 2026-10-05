import "server-only";

/**
 * Public server API of the tenancy module: organizations, memberships, the
 * resolver that turns a session and a URL into a tenant context (M3-1), and
 * what a member may do there: the permission catalog and `can()` (M3-2).
 *
 * Invitations and the screens are M3-3 and M3-4. What is here is what they
 * stand on.
 */
export {
  assertContext, canAccessSite, inTenant, isContext, requireOrgContext, requireSiteContext, resolveOrgContext, resolveSiteContext, resolveSiteWithin,
} from "./context";
export type { OrgContext, RequestMeta, SiteContext, UserActor } from "./context";
export { createOrganization, listOrganizations, updateOrganization } from "./organizations.service";
export { changeMemberRole, leaveOrganization, listMembers, removeMember, transferOwnership } from "./members.service";
export { PERMISSIONS, isPermission, permissionsForRole } from "./permissions";
export type { OwnedResource, OwnScope, Permission, PermissionSet } from "./permissions";
export { can, canActOn, canManageMembers, canTransferOwnership, canUpdateOrganization, requirePermission } from "./policies";
export type { MemberSummary, OrganizationStatus, OrganizationSummary, RoleKey } from "./shared";
