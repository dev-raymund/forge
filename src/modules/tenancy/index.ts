import "server-only";

/**
 * Public server API of the tenancy module (M3-1): organizations, memberships,
 * and the resolver that turns a session and a URL into a tenant context.
 *
 * Permissions (`can()`, the catalog) are M3-2; invitations and the screens are
 * M3-3 and M3-4. What is here is what they stand on.
 */
export {
  assertContext, canAccessSite, inTenant, requireOrgContext, requireSiteContext, resolveOrgContext, resolveSiteContext, resolveSiteWithin,
} from "./context";
export type { OrgContext, RequestMeta, SiteContext, UserActor } from "./context";
export { createOrganization, listOrganizations, updateOrganization } from "./organizations.service";
export { changeMemberRole, leaveOrganization, listMembers, removeMember, transferOwnership } from "./members.service";
export { canManageMembers, canManageOrganization } from "./membership-rules";
export type { MemberSummary, OrganizationStatus, OrganizationSummary, RoleKey } from "./shared";
