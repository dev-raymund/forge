import "server-only";

/**
 * Public server API of the tenancy module: organizations, memberships, the
 * resolver that turns a session and a URL into a tenant context (M3-1), and
 * what a member may do there: the permission catalog and `can()` (M3-2).
 *
 * The organization screens (onboarding, the switcher, settings) are M3-3;
 * invitations and the member screens are M3-4.
 */
export {
  assertContext, canAccessSite, currentRequestMeta, inTenant, isContext, requireOrgContext, requireSiteContext, resolveOrgContext, resolveSiteContext, resolveSiteWithin,
} from "./context";
export type { OrgContext, RequestMeta, SiteContext, UserActor } from "./context";
export { createOrganization, homeOrganization, listOrganizations, updateOrganization } from "./organizations.service";
export { changeMemberRole, leaveOrganization, listMembers, removeMember, transferOwnership } from "./members.service";
export { PERMISSIONS, isPermission, permissionsForRole } from "./permissions";
export type { OwnedResource, OwnScope, Permission, PermissionSet } from "./permissions";
export {
  can, canActOn, canManageMembers, canReadActivity, canTransferOwnership, canUpdateOrganization, canViewOrganizationSettings, requirePermission,
} from "./policies";

// The organization screens (M3-3). Pages in app/(admin) compose these; the
// forms call this module's Server Actions (./actions.ts), which are the only way in.
export { chooseHomeOrganization, homePath } from "./home";
export { requireOrgPage, requireSitePage } from "./page-access";
export type { OrgPageAccess, SitePageAccess } from "./page-access";
export { ONBOARDING_PATH, onboardingSitePath, orgPath, orgSettingsPath, orgSitesPath } from "./paths";
export { looksLikeOrgSlug } from "./slugs";
export { ROLE_LABELS } from "./shared";
export {
  SETTINGS_NOTICES, submitChangeOrganizationSlug, submitCreateOrganization, submitRenameOrganization, submitTransferOwnership,
} from "./organization-forms";
export type { SettingsNotice } from "./organization-forms";
export type { FormOutcome } from "./form-outcome";
// For the other modules' admin forms (sites, M4-1): one way to answer a form, refuse it, and finish an action.
export { pagesOf, refusal } from "./form-outcome";
export { finish } from "./action-support";
export { OrgSwitcher } from "./ui/org-switcher";
export type { SwitcherOrganization } from "./ui/org-switcher";
export { CreateOrganizationForm } from "./ui/create-organization-form";
export { ChangeOrganizationSlugForm, RenameOrganizationForm, TransferOwnership } from "./ui/organization-settings";
export type { TransferCandidate } from "./ui/organization-settings";
export { OrganizationSettingsView } from "./ui/organization-settings-view";

// The activity log (M3-5): who may read it. The rows themselves are the audit module's.
export { listActivity } from "./activity.service";
export { orgActivityPath } from "./paths";

// Members and invitations (M3-4).
export { acceptInvitation, inviteMember, listInvitations, previewInvitation, resendInvitation, revokeInvitation } from "./invitations.service";
export type { AcceptedInvitation, InvitationPreview, InvitationSummary } from "./invitations.service";
export { ASSIGNABLE_ROLES, INVITATION_DAYS, invitationState, isInvitedAccount } from "./invitation-rules";
export { describeMembers, membersViewFor } from "./members-view";
export type { MembersView } from "./members-view";
export {
  submitAcceptInvitation, submitChangeMemberRole, submitInviteMember, submitLeaveOrganization, submitRemoveMember, submitResendInvitation,
  submitRevokeInvitation,
} from "./member-forms";
export { acceptInvitationAction } from "./actions";
export { invitationPath, orgMembersPath } from "./paths";
export { MembersPage } from "./ui/members-view";
export { AcceptInvitationForm } from "./ui/accept-invitation";
export type { MemberSummary, OrganizationStatus, OrganizationSummary, RoleKey } from "./shared";
