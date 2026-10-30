import type { Actor } from "@/modules/auth/shared";
import {
  cancelSchedule, canPublishEntry, canUpdateEntry, createPreviewLink, getDraftHead, listRevisions, overwriteDraft, purgeEntry, rescheduleEntry, restoreEntry, restoreRevision, saveRevision,
  scheduleEntry, submitCancelSchedule, submitCreateEntry, submitDraftHead, submitOverwriteDraft, submitPreviewLink, submitPublishEntry, submitPurgeEntry, submitRescheduleEntry,
  submitRestoreEntry, submitRestoreRevision, submitRevisionHistory, submitSaveDraft, submitSaveRevision, submitScheduleEntry, submitSetHomepage, submitTrashEntry,
  submitUnpublishEntry, trashEntry, unpublishEntry,
} from "@/modules/content";
import {
  completeUpload, deleteFolder, mediaUsage, moveMedia, renameFolder, requestUploads, restoreMedia, submitCompleteUpload, submitDeleteFolder, submitMediaUsage, submitMoveMedia,
  submitRenameFolder,
  submitRequestAvatarUpload, submitRequestUploads, submitRestoreMedia, submitTrashMedia, submitUpdateMedia, trashMedia, updateMediaDetails,
} from "@/modules/media";
import { submitSaveMenu } from "@/modules/navigation";
import { submitCreateRedirect, submitDeleteRedirect, submitSetNotFoundPage, submitUpdateRedirect } from "@/modules/seo";
import {
  listSites, submitAppearancePreview, submitChangeSiteAddress, submitChooseTheme, submitCreateSite, submitDeleteSite, submitSetSiteImage, submitSetSiteStatus,
  submitUpdateAppearance, submitUpdateSeoSettings, submitUpdateSiteSettings,
} from "@/modules/sites";
import {
  acceptInvitation, can, canActOn, changeMemberRole, listActivity, listInvitations, listMembers, PERMISSIONS, removeMember, resendInvitation, resolveOrgContext,
  resolveSiteContext, revokeInvitation, submitAcceptInvitation, submitChangeMemberRole, submitChangeOrganizationSlug, submitCreateOrganization,
  submitInviteMember, submitLeaveOrganization, submitRemoveMember, submitRenameOrganization, submitResendInvitation, submitRevokeInvitation,
  submitTransferOwnership, transferOwnership, updateOrganization,
  type FormOutcome, type OrgContext, type OwnedResource, type OwnScope, type Permission, type SiteContext,
} from "@/modules/tenancy";
import { AppError, type ActionResult } from "@/platform/errors";
import { studio } from "@/themes/studio/definition";

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
export type Caller = { actor: Actor; ctx: OrgContext; orgSlug: string; /** A site of A's (M5-3: entry forms are on a site's URL). */ siteSlug: string };

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
  /** A page of B's site (M5-3). */
  entryId: string;
  /** A media item of B's site, uploaded by B's Owner (M6-1). */
  mediaId: string;
  /** A media folder of B's site (M6-3). */
  folderId: string;
  /** A redirect of B's site (M8-5). */
  redirectId: string;
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

  // Uploads (M6-1): finishing B's upload from A's site; starting one on B's site, named from A's URL or B's.
  { name: "media.completeUpload(A's site, B's media)", run: async ({ actor, orgSlug, siteSlug }, b) => completeUpload(await resolveSiteContext(actor, orgSlug, siteSlug), b.mediaId) },
  { name: "media.completeUpload(A's site, B's site id as the media)", run: async ({ actor, orgSlug, siteSlug }, b) => completeUpload(await resolveSiteContext(actor, orgSlug, siteSlug), b.siteId) },
  { name: "media.requestUploads(A's slug, B's site)", run: async ({ actor, orgSlug }, b) => requestUploads(await resolveSiteContext(actor, orgSlug, b.siteSlug), [UPLOAD]) },
  // The Server Actions answer with a result instead of throwing: their refusal, rethrown as what it says.
  { name: "media.submitCompleteUpload(A's slug, A's site, B's media)", run: ({ actor, orgSlug, siteSlug }, b) => refused(submitCompleteUpload(actor, orgSlug, siteSlug, b.mediaId)) },
  { name: "media.submitCompleteUpload(B's slug, B's site, B's media)", run: ({ actor }, b) => refused(submitCompleteUpload(actor, b.orgSlug, b.siteSlug, b.mediaId)) },
  { name: "media.submitRequestUploads(B's slug, B's site)", run: ({ actor }, b) => refused(submitRequestUploads(actor, b.orgSlug, b.siteSlug, [UPLOAD])) },
  { name: "media.submitRequestUploads(A's slug, B's site id as the slug)", run: ({ actor, orgSlug }, b) => refused(submitRequestUploads(actor, orgSlug, b.siteId, [UPLOAD])) },

  // The library (M6-3): B's file or folder named on A's site.
  ...([
    ["updateMediaDetails", (ctx: SiteContext, b: Foreign) => updateMediaDetails(ctx, b.mediaId, { title: "Hijacked" })],
    ["trashMedia", (ctx: SiteContext, b: Foreign) => trashMedia(ctx, b.mediaId)],
    ["restoreMedia", (ctx: SiteContext, b: Foreign) => restoreMedia(ctx, b.mediaId)],
    ["moveMedia", (ctx: SiteContext, b: Foreign) => moveMedia(ctx, [b.mediaId], null)],
    ["renameFolder", (ctx: SiteContext, b: Foreign) => renameFolder(ctx, b.folderId, { name: "Hijacked" })],
    ["deleteFolder", (ctx: SiteContext, b: Foreign) => deleteFolder(ctx, b.folderId)],
  ] as const).map(([name, run]) => ({
    name: `media.${name}(A's site, B's ${name.includes("Folder") ? "folder" : "media"})`,
    run: async ({ actor, orgSlug, siteSlug }: Caller, b: Foreign) => run(await resolveSiteContext(actor, orgSlug, siteSlug), b),
  })),
  // The lifecycle (M7-1): B's entry named on A's site, in the trash or not.
  ...([
    ["unpublishEntry", unpublishEntry],
    ["trashEntry", trashEntry],
    ["restoreEntry", restoreEntry],
    ["purgeEntry", purgeEntry],
  ] as const).map(([name, run]) => ({
    name: `content.${name}(A's site, B's entry)`,
    run: async ({ actor, orgSlug, siteSlug }: Caller, b: Foreign) => run(await resolveSiteContext(actor, orgSlug, siteSlug), b.entryId),
  })),
  // Scheduling (M7-2): B's entry named on A's site.
  {
    name: "content.scheduleEntry(A's site, B's entry)",
    run: async ({ actor, orgSlug, siteSlug }, b) => scheduleEntry(await resolveSiteContext(actor, orgSlug, siteSlug), b.entryId, { runAt: SOON, version: 1 }),
  },
  { name: "content.rescheduleEntry(A's site, B's entry)", run: async ({ actor, orgSlug, siteSlug }, b) => rescheduleEntry(await resolveSiteContext(actor, orgSlug, siteSlug), b.entryId, { runAt: SOON }) },
  { name: "content.cancelSchedule(A's site, B's entry)", run: async ({ actor, orgSlug, siteSlug }, b) => cancelSchedule(await resolveSiteContext(actor, orgSlug, siteSlug), b.entryId) },
  // The history (M7-3): B's entry named on A's site; read, kept, restored or overwritten; and its reads from B's URL.
  ...([
    ["listRevisions", (ctx: SiteContext, b: Foreign) => listRevisions(ctx, b.entryId)],
    ["getDraftHead", (ctx: SiteContext, b: Foreign) => getDraftHead(ctx, b.entryId)],
    ["saveRevision", (ctx: SiteContext, b: Foreign) => saveRevision(ctx, b.entryId, { version: 1 })],
    ["restoreRevision", (ctx: SiteContext, b: Foreign) => restoreRevision(ctx, b.entryId, { revisionId: b.entryId, version: 1 })],
    ["overwriteDraft", (ctx: SiteContext, b: Foreign) => overwriteDraft(ctx, b.entryId, { replaceVersion: 1, draft: { title: "Hijacked" } })],
  ] as const).map(([name, run]) => ({
    name: `content.${name}(A's site, B's entry)`,
    run: async ({ actor, orgSlug, siteSlug }: Caller, b: Foreign) => run(await resolveSiteContext(actor, orgSlug, siteSlug), b),
  })),
  { name: "content.submitRevisionHistory(B's slug, B's site, B's entry)", run: ({ actor }, b) => refused(submitRevisionHistory(actor, b.orgSlug, b.siteSlug, b.entryId, undefined)) },
  { name: "content.submitRevisionHistory(A's slug, A's site, B's entry)", run: ({ actor, orgSlug, siteSlug }, b) => refused(submitRevisionHistory(actor, orgSlug, siteSlug, b.entryId, undefined)) },
  { name: "content.submitDraftHead(B's slug, B's site, B's entry)", run: ({ actor }, b) => refused(submitDraftHead(actor, b.orgSlug, b.siteSlug, b.entryId)) },
  { name: "content.submitDraftHead(A's slug, A's site, B's entry)", run: ({ actor, orgSlug, siteSlug }, b) => refused(submitDraftHead(actor, orgSlug, siteSlug, b.entryId)) },
  // The appearance editor's preview (M8-1): a preview of B's site, from B's URL or A's.
  { name: "sites.submitAppearancePreview(B's slug, B's site)", run: ({ actor }, b) => refused(submitAppearancePreview(actor, b.orgSlug, b.siteSlug, form({ settings: JSON.stringify(APPEARANCE) }))) },
  { name: "sites.submitAppearancePreview(A's slug, B's site)", run: ({ actor, orgSlug }, b) => refused(submitAppearancePreview(actor, orgSlug, b.siteSlug, form({ settings: JSON.stringify(APPEARANCE) }))) },
  // Previews (M7-4): a link to B's entry (its draft, or a revision), from A's site or B's URL.
  { name: "content.createPreviewLink(A's site, B's entry)", run: async ({ actor, orgSlug, siteSlug }, b) => createPreviewLink(await resolveSiteContext(actor, orgSlug, siteSlug), b.entryId) },
  {
    name: "content.createPreviewLink(A's site, B's entry, a revision)",
    run: async ({ actor, orgSlug, siteSlug }, b) => createPreviewLink(await resolveSiteContext(actor, orgSlug, siteSlug), b.entryId, { revisionId: b.entryId }),
  },
  { name: "content.submitPreviewLink(B's slug, B's site, B's entry)", run: ({ actor }, b) => refused(submitPreviewLink(actor, b.orgSlug, b.siteSlug, b.entryId, undefined)) },
  { name: "content.submitPreviewLink(A's slug, A's site, B's entry)", run: ({ actor, orgSlug, siteSlug }, b) => refused(submitPreviewLink(actor, orgSlug, siteSlug, b.entryId, undefined)) },
  // The warning before a file goes to the trash (M7-1): where B's file is used, asked from A's site or B's URL.
  { name: "media.mediaUsage(A's site, B's media)", run: async ({ actor, orgSlug, siteSlug }, b) => mediaUsage(await resolveSiteContext(actor, orgSlug, siteSlug), b.mediaId) },
  { name: "media.submitMediaUsage(A's slug, A's site, B's media)", run: ({ actor, orgSlug, siteSlug }, b) => refused(submitMediaUsage(actor, orgSlug, siteSlug, b.mediaId)) },
  { name: "media.submitMediaUsage(B's slug, B's site, B's media)", run: ({ actor }, b) => refused(submitMediaUsage(actor, b.orgSlug, b.siteSlug, b.mediaId)) },
  { name: "media.submitUpdateMedia(B's slug, B's site, B's media)", run: ({ actor }, b) => refusedForm(submitUpdateMedia(actor, b.orgSlug, b.siteSlug, b.mediaId, formOf({ title: "x" }))) },
  { name: "media.submitTrashMedia(A's slug, A's site, B's media)", run: ({ actor, orgSlug, siteSlug }, b) => refusedForm(submitTrashMedia(actor, orgSlug, siteSlug, b.mediaId)) },
  { name: "media.submitRestoreMedia(A's slug, A's site, B's media)", run: ({ actor, orgSlug, siteSlug }, b) => refusedForm(submitRestoreMedia(actor, orgSlug, siteSlug, b.mediaId)) },
  { name: "media.submitMoveMedia(A's slug, A's site, B's media)", run: ({ actor, orgSlug, siteSlug }, b) => refusedForm(submitMoveMedia(actor, orgSlug, siteSlug, [b.mediaId], null)) },
  { name: "media.submitRenameFolder(B's slug, B's site, B's folder)", run: ({ actor }, b) => refusedForm(submitRenameFolder(actor, b.orgSlug, b.siteSlug, b.folderId, formOf({ name: "x" }))) },
  { name: "media.submitDeleteFolder(A's slug, A's site, B's folder)", run: ({ actor, orgSlug, siteSlug }, b) => refusedForm(submitDeleteFolder(actor, orgSlug, siteSlug, b.folderId)) },
];

const UPLOAD = { name: "photo.png", size: 1_024, type: "image/png" };
/** Complete, valid appearance settings (Studio's defaults), so a refusal is never about the settings (M8-1). */
const APPEARANCE = studio.defaults;
const appearanceForm = () => {
  const data = new FormData();
  data.set("settings", JSON.stringify(APPEARANCE));
  data.set("version", "1");
  return data;
};
/** A whole menu (M8-3): one link, to the blog, as if the menu had never been saved. */
const menuForm = () => {
  const data = new FormData();
  data.set("items", JSON.stringify([{ id: "01900000-0000-7000-8000-000000000001", kind: "archive", contentType: "post", label: "Blog", newTab: false }]));
  data.set("version", "0");
  return data;
};
/** A site's SEO defaults (M8-4): discourage indexing, as if nothing had been saved since the site was made. */
const seoForm = () => {
  const data = new FormData();
  data.set("seo", JSON.stringify({ titleTemplate: "%title% %sep% %site%", defaultDescription: "Hijacked", defaultOgImageId: null, discourageIndexing: true, searchConsoleToken: "" }));
  data.set("version", "1");
  return data;
};
/** A wall-clock time well in the future, in any zone (M7-2). */
const SOON = `${new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)}T09:00`;
const formOf = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

/** A form submission's refusal as the `AppError` it stands for. */
async function refusedForm(outcome: Promise<FormOutcome>): Promise<FormOutcome> {
  const answer = await outcome;
  if (!answer.refused) return answer;
  throw new AppError(answer.refused === "Internal" ? "Unavailable" : answer.refused, answer.refused === "NotFound" ? "Not found." : (answer.state.message ?? ""));
}

/** An action's refusal as the `AppError` it stands for; a success is returned (and fails a check that expects a refusal). */
async function refused<T>(result: Promise<ActionResult<T>>): Promise<T> {
  const answer = await result;
  if (answer.ok) return answer.data;
  throw new AppError(answer.code === "Internal" ? "Unavailable" : answer.code, answer.error);
}

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
  // Uploads (M6-1): a file described with B's organization, site, media id and a key in B's prefix is still A's,
  // on A's site, under a key made by the server.
  {
    name: "media.requestUploads(A's site, file fields naming B)",
    run: async ({ actor, orgSlug, siteSlug }, b) => {
      const ctx = await resolveSiteContext(actor, orgSlug, siteSlug);
      const file = { ...UPLOAD, organizationId: b.orgId, siteId: b.siteId, mediaId: b.mediaId, id: b.mediaId, key: `o/${b.orgId}/s/${b.siteId}/m/${b.mediaId}/v1/original/x.png`, storageKey: `o/${b.orgId}/s/${b.siteId}/x.png` };
      const { uploads } = await requestUploads(ctx, [file]);
      if (uploads.length !== 1 || uploads[0]!.mediaId === b.mediaId || !uploads[0]!.upload.url.includes(`o/${ctx.org.id}/s/${ctx.site.id}/m/${uploads[0]!.mediaId}/`)) {
        throw new Error(`expected an upload of A's own: ${JSON.stringify(uploads)}`);
      }
      return uploads;
    },
  },
  // The account avatar (M6-2): the caller's own, under the caller's own prefix, whatever user or organization the file names.
  {
    name: "media.submitRequestAvatarUpload(file fields naming B's user and organization)",
    run: async ({ actor, ctx }, b) => {
      const result = await submitRequestAvatarUpload(actor, { ...UPLOAD, userId: b.userId, organizationId: b.orgId, key: `u/${b.userId}/a/x/original/avatar.upload` });
      if (!result.ok || !result.data.upload.url.includes(`/u/${ctx.actor.userId}/a/${result.data.avatarId}/`) || result.data.upload.url.includes(b.userId)) {
        throw new Error(`expected an avatar upload of the caller's own: ${JSON.stringify(result)}`);
      }
      return result;
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
  // The appearance editor (M8-1): B's site's settings, from B's URL, A's, or with B's site id as the slug.
  { name: "sites.submitUpdateAppearance(B's slug, B's site)", run: ({ actor }, b) => submitUpdateAppearance(actor, b.orgSlug, b.siteSlug, appearanceForm()) },
  { name: "sites.submitUpdateAppearance(A's slug, B's site)", run: ({ actor, orgSlug }, b) => submitUpdateAppearance(actor, orgSlug, b.siteSlug, appearanceForm()) },
  { name: "sites.submitUpdateAppearance(A's slug, B's site id as the slug)", run: ({ actor, orgSlug }, b) => submitUpdateAppearance(actor, orgSlug, b.siteId, appearanceForm()) },

  // Menus (M8-3): B's site's header menu, from B's URL, A's, or with B's site id as the slug.
  { name: "navigation.submitSaveMenu(B's slug, B's site)", run: ({ actor }, b) => submitSaveMenu(actor, b.orgSlug, b.siteSlug, "header", menuForm()) },
  { name: "navigation.submitSaveMenu(A's slug, B's site)", run: ({ actor, orgSlug }, b) => submitSaveMenu(actor, orgSlug, b.siteSlug, "header", menuForm()) },
  { name: "navigation.submitSaveMenu(A's slug, B's site id as the slug)", run: ({ actor, orgSlug }, b) => submitSaveMenu(actor, orgSlug, b.siteId, "footer", menuForm()) },

  // SEO settings (M8-4): B's site's defaults, from B's URL, A's, or with B's site id as the slug.
  { name: "sites.submitUpdateSeoSettings(B's slug, B's site)", run: ({ actor }, b) => submitUpdateSeoSettings(actor, b.orgSlug, b.siteSlug, seoForm()) },
  { name: "sites.submitUpdateSeoSettings(A's slug, B's site)", run: ({ actor, orgSlug }, b) => submitUpdateSeoSettings(actor, orgSlug, b.siteSlug, seoForm()) },
  { name: "sites.submitUpdateSeoSettings(A's slug, B's site id as the slug)", run: ({ actor, orgSlug }, b) => submitUpdateSeoSettings(actor, orgSlug, b.siteId, seoForm()) },

  // Redirects (M8-5): B's site's redirects and not-found page, from B's URL, A's, or with B's site id as the slug; B's
  // redirect, or B's page as the not-found page, from A's own site.
  { name: "seo.submitCreateRedirect(B's slug, B's site)", run: ({ actor }, b) => submitCreateRedirect(actor, b.orgSlug, b.siteSlug, form({ source: "/hijack", destination: "/" })) },
  { name: "seo.submitCreateRedirect(A's slug, B's site)", run: ({ actor, orgSlug }, b) => submitCreateRedirect(actor, orgSlug, b.siteSlug, form({ source: "/hijack", destination: "/" })) },
  { name: "seo.submitCreateRedirect(A's slug, B's site id as the slug)", run: ({ actor, orgSlug }, b) => submitCreateRedirect(actor, orgSlug, b.siteId, form({ source: "/hijack", destination: "/" })) },
  { name: "seo.submitUpdateRedirect(B's slug, B's site, B's redirect)", run: ({ actor }, b) => submitUpdateRedirect(actor, b.orgSlug, b.siteSlug, b.redirectId, form({ isActive: "false" })) },
  { name: "seo.submitUpdateRedirect(A's own site, B's redirect)", run: ({ actor, orgSlug, siteSlug }, b) => submitUpdateRedirect(actor, orgSlug, siteSlug, b.redirectId, form({ destination: "https://evil.example/" })) },
  { name: "seo.submitDeleteRedirect(B's slug, B's site, B's redirect)", run: ({ actor }, b) => submitDeleteRedirect(actor, b.orgSlug, b.siteSlug, b.redirectId, form({})) },
  { name: "seo.submitDeleteRedirect(A's own site, B's redirect)", run: ({ actor, orgSlug, siteSlug }, b) => submitDeleteRedirect(actor, orgSlug, siteSlug, b.redirectId, form({})) },
  { name: "seo.submitSetNotFoundPage(B's slug, B's site)", run: ({ actor }, b) => submitSetNotFoundPage(actor, b.orgSlug, b.siteSlug, form({ entryId: "" })) },
  { name: "seo.submitSetNotFoundPage(A's own site, B's page)", run: ({ actor, orgSlug, siteSlug }, b) => submitSetNotFoundPage(actor, orgSlug, siteSlug, form({ entryId: b.entryId })) },

  // Publishing (M4-5): B's site, live or back to Coming soon, from B's URL or A's.
  ...(["live", "coming_soon"] as const).flatMap((status) => [
    { name: `sites.submitSetSiteStatus(B's slug, B's site, ${status})`, run: ({ actor }: Caller, b: Foreign) => submitSetSiteStatus(actor, b.orgSlug, b.siteSlug, form({ status })) },
    { name: `sites.submitSetSiteStatus(A's slug, B's site, ${status})`, run: ({ actor, orgSlug }: Caller, b: Foreign) => submitSetSiteStatus(actor, orgSlug, b.siteSlug, form({ status })) },
    { name: `sites.submitSetSiteStatus(A's slug, B's site id, ${status})`, run: ({ actor, orgSlug }: Caller, b: Foreign) => submitSetSiteStatus(actor, orgSlug, b.siteId, form({ status, siteId: b.siteId })) },
  ]),

  // Entries (M5-3): B's entry from B's URL, or from A's own site's URL; a new entry on B's site.
  { name: "content.submitCreateEntry(B's slug, B's site)", run: ({ actor }: Caller, b: Foreign) => submitCreateEntry(actor, b.orgSlug, b.siteSlug, "page", form({ title: "Hijack" })) },
  { name: "content.submitCreateEntry(A's slug, B's site)", run: ({ actor, orgSlug }: Caller, b: Foreign) => submitCreateEntry(actor, orgSlug, b.siteSlug, "post", form({ title: "Hijack" })) },
  ...([
    ["submitSaveDraft", (actor: Actor, org: string, site: string, entry: string) => submitSaveDraft(actor, org, site, entry, form({ version: "1", draft: JSON.stringify({ title: "Hijacked" }) }))],
    ["submitPublishEntry", (actor: Actor, org: string, site: string, entry: string) => submitPublishEntry(actor, org, site, entry, form({ version: "1" }))],
    ["submitSetHomepage", (actor: Actor, org: string, site: string, entry: string) => submitSetHomepage(actor, org, site, entry, form({}))],
    // M7-1.
    ["submitUnpublishEntry", (actor: Actor, org: string, site: string, entry: string) => submitUnpublishEntry(actor, org, site, entry, form({}))],
    ["submitTrashEntry", (actor: Actor, org: string, site: string, entry: string) => submitTrashEntry(actor, org, site, entry, form({}))],
    ["submitRestoreEntry", (actor: Actor, org: string, site: string, entry: string) => submitRestoreEntry(actor, org, site, entry, form({}))],
    ["submitPurgeEntry", (actor: Actor, org: string, site: string, entry: string) => submitPurgeEntry(actor, org, site, entry, form({}))],
    // M7-2.
    ["submitScheduleEntry", (actor: Actor, org: string, site: string, entry: string) => submitScheduleEntry(actor, org, site, entry, form({ runAt: SOON, version: "1" }))],
    ["submitRescheduleEntry", (actor: Actor, org: string, site: string, entry: string) => submitRescheduleEntry(actor, org, site, entry, form({ runAt: SOON }))],
    ["submitCancelSchedule", (actor: Actor, org: string, site: string, entry: string) => submitCancelSchedule(actor, org, site, entry, form({}))],
    // M7-3.
    ["submitSaveRevision", (actor: Actor, org: string, site: string, entry: string) => submitSaveRevision(actor, org, site, entry, form({ version: "1", label: "Hijacked" }))],
    ["submitRestoreRevision", (actor: Actor, org: string, site: string, entry: string) => submitRestoreRevision(actor, org, site, entry, form({ revisionId: entry, version: "1" }))],
    [
      "submitOverwriteDraft",
      (actor: Actor, org: string, site: string, entry: string) => submitOverwriteDraft(actor, org, site, entry, form({ replaceVersion: "1", draft: JSON.stringify({ title: "Hijacked" }) })),
    ],
  ] as const).flatMap(([name, submit]) => [
    { name: `content.${name}(B's slug, B's site, B's entry)`, run: ({ actor }: Caller, b: Foreign) => submit(actor, b.orgSlug, b.siteSlug, b.entryId) },
    { name: `content.${name}(A's slug, A's site, B's entry)`, run: ({ actor, orgSlug, siteSlug }: Caller, b: Foreign) => submit(actor, orgSlug, siteSlug, b.entryId) },
  ]),

  // Settings (M4-2): every group, for B's site, from B's URL or A's.
  ...(["general", "reading", "analytics"] as const).flatMap((group) => {
    const fields = form({ name: "Hijacked", tagline: "x", language: "en", timezone: "UTC", blogPath: "hijack", postsPerPage: "5", ga4MeasurementId: "G-HIJACK123", version: "1" });
    return [
      { name: `sites.submitUpdateSiteSettings(B's slug, B's site, ${group})`, run: ({ actor }: Caller, b: Foreign) => submitUpdateSiteSettings(actor, b.orgSlug, b.siteSlug, group, fields) },
      { name: `sites.submitUpdateSiteSettings(A's slug, B's site, ${group})`, run: ({ actor, orgSlug }: Caller, b: Foreign) => submitUpdateSiteSettings(actor, orgSlug, b.siteSlug, group, fields) },
      { name: `sites.submitUpdateSiteSettings(A's slug, B's site id, ${group})`, run: ({ actor, orgSlug }: Caller, b: Foreign) => submitUpdateSiteSettings(actor, orgSlug, b.siteId, group, fields) },
    ];
  }),

  // The logo and favicon (M6-4): B's image for B's site, from B's URL or A's. (B's image on A's site is refused as an
  // image that is not the site's, the same answer as an id of nothing: media-images.test.ts.)
  ...(["logo", "favicon"] as const).flatMap((role) => [
    { name: `sites.submitSetSiteImage(B's slug, B's site, ${role}, B's media)`, run: ({ actor }: Caller, b: Foreign) => submitSetSiteImage(actor, b.orgSlug, b.siteSlug, role, form({ mediaId: b.mediaId })) },
    { name: `sites.submitSetSiteImage(A's slug, B's site, ${role}, B's media)`, run: ({ actor, orgSlug }: Caller, b: Foreign) => submitSetSiteImage(actor, orgSlug, b.siteSlug, role, form({ mediaId: b.mediaId })) },
    { name: `sites.submitSetSiteImage(B's slug, B's site, ${role}, removed)`, run: ({ actor }: Caller, b: Foreign) => submitSetSiteImage(actor, b.orgSlug, b.siteSlug, role, form({})) },
  ]),
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
  // M5-3: B's page or post, recorded as written by this very user.
  {
    name: "content.canUpdateEntry / canPublishEntry(B's page and post)",
    run: (ctx, resource) =>
      (["page", "post"] as const).flatMap((type) => {
        const entry = { type, organizationId: resource.organizationId, authorId: resource.ownerId };
        return [canUpdateEntry(ctx, entry) ? `update ${type}` : null, canPublishEntry(ctx, entry) ? `publish ${type}` : null].filter((key): key is string => key !== null);
      }),
  },
];
