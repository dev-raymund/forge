import type { Actor } from "@/modules/auth/shared";
import { listSites, submitChangeSiteAddress, submitChooseTheme, submitCreateSite, submitDeleteSite, submitUpdateSiteSettings } from "@/modules/sites";
import {
  acceptInvitation, can, canActOn, changeMemberRole, listActivity, listInvitations, listMembers, PERMISSIONS, removeMember, resendInvitation, resolveOrgContext,
  resolveSiteContext, revokeInvitation, submitAcceptInvitation, submitChangeMemberRole, submitChangeOrganizationSlug, submitCreateOrganization,
  submitInviteMember, submitLeaveOrganization, submitRemoveMember, submitRenameOrganization, submitResendInvitation, submitRevokeInvitation,
  submitTransferOwnership, transferOwnership, updateOrganization,
  type FormOutcome, type OrgContext, type OwnedResource, type OwnScope, type Permission,
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
  /** An open invitation of B. Its id, which is not its token. */
  invitationId: string;
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

  // Invitations (M3-4): named by invitation id when managed, by token when answered.
  { name: "tenancy.resendInvitation(B's invitation)", run: ({ ctx }, b) => resendInvitation(ctx, { invitationId: b.invitationId }) },
  { name: "tenancy.revokeInvitation(B's invitation)", run: ({ ctx }, b) => revokeInvitation(ctx, { invitationId: b.invitationId }) },
  { name: "tenancy.revokeInvitation(B's member id as the invitation id)", run: ({ ctx }, b) => revokeInvitation(ctx, { invitationId: b.memberId }) },
  { name: "tenancy.acceptInvitation(B's invitation id as the token)", run: ({ actor }, b) => acceptInvitation(actor, b.invitationId) },
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
  // The forms (M3-3), on the caller's own URL, with B's identifiers in fields no form has.
  {
    name: "tenancy.submitRenameOrganization(A's slug, extra fields naming B)",
    run: ({ actor, orgSlug }, b) => submitRenameOrganization(actor, orgSlug, form({ name: "Still A", id: b.orgId, organizationId: b.orgId, orgSlug: b.orgSlug, slug: b.orgSlug })),
  },
  {
    name: "tenancy.submitCreateOrganization(extra fields naming B)",
    run: ({ actor }, b) =>
      submitCreateOrganization(actor, form({ name: "Another Of A's", slug: `iso-${b.orgId.slice(-12)}-${Date.now().toString(36)}`, id: b.orgId, organizationId: b.orgId, ownerId: b.userId })),
  },
  // The activity log (M3-5): filters that name B narrow A's own log, and write nothing anywhere.
  { name: "tenancy.listActivity(filters naming B's member and site)", run: ({ ctx }, b) => listActivity(ctx, { member: b.memberId, site: b.siteId }) },
  // Sites (M4-1): the list is the caller's own organization's, and a new site is created there, whatever the form also says.
  { name: "sites.listSites()", run: ({ ctx }) => listSites(ctx) },
  {
    name: "sites.submitCreateSite(A's slug, extra fields naming B)",
    run: async ({ actor, orgSlug }, b) => {
      const outcome = await submitCreateSite(
        actor,
        orgSlug,
        form({ name: "Of A's", address: `iso-${Date.now().toString(36)}-${b.orgId.slice(-8)}`, language: "en", timezone: "UTC", organizationId: b.orgId, orgSlug: b.orgSlug, siteId: b.siteId }),
      );
      if (outcome.state.status !== "success") throw new Error(`expected the site to be created in A: ${JSON.stringify(outcome.state)}`);
      return outcome;
    },
  },
  // Members and invitations (M3-4).
  { name: "tenancy.listInvitations()", run: ({ ctx }) => listInvitations(ctx) },
  {
    name: "tenancy.submitInviteMember(A's slug, extra fields naming B)",
    run: ({ actor, orgSlug }, b) =>
      submitInviteMember(
        actor,
        orgSlug,
        form({ email: `iso-${b.orgId.slice(-12)}-${Date.now().toString(36)}@example.test`, role: "viewer", organizationId: b.orgId, orgSlug: b.orgSlug, invitedBy: b.userId }),
      ),
  },
];

/**
 * The form submissions behind the Server Actions (M3-3). They take the slug
 * from the page's URL and answer with a form state instead of throwing. Given
 * B's slug, or B's member on A's own page, each must be refused as `NotFound`,
 * send the browser nowhere, and leave B as it was. Register every new form
 * action here through its `submit…` function.
 */
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

export const tenantForms: { name: string; run: (caller: Caller, foreign: Foreign) => Promise<FormOutcome> }[] = [
  { name: "tenancy.submitRenameOrganization(B's slug)", run: ({ actor }, b) => submitRenameOrganization(actor, b.orgSlug, form({ name: "Hijacked" })) },
  { name: "tenancy.submitChangeOrganizationSlug(B's slug)", run: ({ actor }, b) => submitChangeOrganizationSlug(actor, b.orgSlug, form({ slug: `hijacked-${b.orgId.slice(-12)}` })) },
  {
    name: "tenancy.submitTransferOwnership(B's slug, B's member)",
    run: ({ actor }, b) => submitTransferOwnership(actor, b.orgSlug, form({ memberId: b.memberId, confirm: b.orgSlug })),
  },
  {
    name: "tenancy.submitTransferOwnership(B's slug, the caller's own membership)",
    run: ({ actor, ctx }, b) => submitTransferOwnership(actor, b.orgSlug, form({ memberId: ctx.membership.id, confirm: b.orgSlug })),
  },
  {
    name: "tenancy.submitTransferOwnership(A's slug, B's member)",
    run: ({ actor, orgSlug }, b) => submitTransferOwnership(actor, orgSlug, form({ memberId: b.memberId, confirm: orgSlug })),
  },
  {
    name: "tenancy.submitTransferOwnership(A's slug, B's user id as the member)",
    run: ({ actor, orgSlug }, b) => submitTransferOwnership(actor, orgSlug, form({ memberId: b.userId, confirm: orgSlug })),
  },

  // Members and invitations (M3-4): B's page, or B's member or invitation named on A's page.
  { name: "tenancy.submitInviteMember(B's slug)", run: ({ actor }, b) => submitInviteMember(actor, b.orgSlug, form({ email: "someone@example.test", role: "viewer" })) },
  { name: "tenancy.submitResendInvitation(B's slug, B's invitation)", run: ({ actor }, b) => submitResendInvitation(actor, b.orgSlug, form({ invitationId: b.invitationId })) },
  { name: "tenancy.submitResendInvitation(A's slug, B's invitation)", run: ({ actor, orgSlug }, b) => submitResendInvitation(actor, orgSlug, form({ invitationId: b.invitationId })) },
  { name: "tenancy.submitRevokeInvitation(B's slug, B's invitation)", run: ({ actor }, b) => submitRevokeInvitation(actor, b.orgSlug, form({ invitationId: b.invitationId })) },
  { name: "tenancy.submitRevokeInvitation(A's slug, B's invitation)", run: ({ actor, orgSlug }, b) => submitRevokeInvitation(actor, orgSlug, form({ invitationId: b.invitationId })) },
  { name: "tenancy.submitChangeMemberRole(B's slug, B's member)", run: ({ actor }, b) => submitChangeMemberRole(actor, b.orgSlug, form({ memberId: b.memberId, role: "viewer" })) },
  { name: "tenancy.submitChangeMemberRole(A's slug, B's member)", run: ({ actor, orgSlug }, b) => submitChangeMemberRole(actor, orgSlug, form({ memberId: b.memberId, role: "viewer" })) },
  { name: "tenancy.submitRemoveMember(B's slug, B's member)", run: ({ actor }, b) => submitRemoveMember(actor, b.orgSlug, form({ memberId: b.memberId })) },
  { name: "tenancy.submitRemoveMember(A's slug, B's member)", run: ({ actor, orgSlug }, b) => submitRemoveMember(actor, orgSlug, form({ memberId: b.memberId })) },
  { name: "tenancy.submitLeaveOrganization(B's slug)", run: ({ actor }, b) => submitLeaveOrganization(actor, b.orgSlug, new FormData()) },
  { name: "tenancy.submitAcceptInvitation(B's invitation id as the token)", run: ({ actor }, b) => submitAcceptInvitation(actor, b.invitationId) },

  // Sites (M4-1): B's organization in the URL, or B's site named on A's own page.
  { name: "sites.submitCreateSite(B's slug)", run: ({ actor }, b) => submitCreateSite(actor, b.orgSlug, form({ name: "Planted", address: `planted-${b.orgId.slice(-12)}`, language: "en", timezone: "UTC" })) },
  { name: "sites.submitChangeSiteAddress(B's slug, B's site)", run: ({ actor }, b) => submitChangeSiteAddress(actor, b.orgSlug, b.siteSlug, form({ address: `moved-${b.orgId.slice(-12)}` })) },
  { name: "sites.submitChangeSiteAddress(A's slug, B's site)", run: ({ actor, orgSlug }, b) => submitChangeSiteAddress(actor, orgSlug, b.siteSlug, form({ address: `moved-${b.orgId.slice(-12)}` })) },
  { name: "sites.submitChangeSiteAddress(A's slug, B's site id as the slug)", run: ({ actor, orgSlug }, b) => submitChangeSiteAddress(actor, orgSlug, b.siteId, form({ address: `moved-${b.orgId.slice(-12)}` })) },
  { name: "sites.submitDeleteSite(B's slug, B's site)", run: ({ actor }, b) => submitDeleteSite(actor, b.orgSlug, b.siteSlug, form({ confirm: b.siteSlug })) },
  { name: "sites.submitDeleteSite(A's slug, B's site)", run: ({ actor, orgSlug }, b) => submitDeleteSite(actor, orgSlug, b.siteSlug, form({ confirm: b.siteSlug })) },

  // Appearance (M4-4): choosing a theme for B's site, from B's URL or A's.
  { name: "sites.submitChooseTheme(B's slug, B's site)", run: ({ actor }, b) => submitChooseTheme(actor, b.orgSlug, b.siteSlug, form({ theme: "journal" })) },
  { name: "sites.submitChooseTheme(A's slug, B's site)", run: ({ actor, orgSlug }, b) => submitChooseTheme(actor, orgSlug, b.siteSlug, form({ theme: "journal" })) },
  { name: "sites.submitChooseTheme(A's slug, B's site id as the slug)", run: ({ actor, orgSlug }, b) => submitChooseTheme(actor, orgSlug, b.siteId, form({ theme: "journal" })) },

  // Settings (M4-2): every group, for B's site, from B's URL or A's.
  ...(["general", "reading", "analytics"] as const).flatMap((group) => {
    const fields = form({ name: "Hijacked", tagline: "x", language: "en", timezone: "UTC", blogPath: "hijack", postsPerPage: "5", ga4MeasurementId: "G-HIJACK123", version: "1" });
    return [
      { name: `sites.submitUpdateSiteSettings(B's slug, B's site, ${group})`, run: ({ actor }: Caller, b: Foreign) => submitUpdateSiteSettings(actor, b.orgSlug, b.siteSlug, group, fields) },
      { name: `sites.submitUpdateSiteSettings(A's slug, B's site, ${group})`, run: ({ actor, orgSlug }: Caller, b: Foreign) => submitUpdateSiteSettings(actor, orgSlug, b.siteSlug, group, fields) },
      { name: `sites.submitUpdateSiteSettings(A's slug, B's site id, ${group})`, run: ({ actor, orgSlug }: Caller, b: Foreign) => submitUpdateSiteSettings(actor, orgSlug, b.siteId, group, fields) },
    ];
  }),
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
