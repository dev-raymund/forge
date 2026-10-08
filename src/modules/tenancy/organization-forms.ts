import "server-only";
import type { Actor } from "@/modules/auth";
import { validationError } from "@/platform/errors";
import { text } from "@/platform/forms";
import { resolveOrgContext, type RequestMeta } from "./context";
import { pagesOf, refusal, type FormOutcome } from "./form-outcome";
import { transferOwnership } from "./members.service";
import { createOrganization, updateOrganization } from "./organizations.service";
import { ONBOARDING_PATH, orgSettingsPath, orgSitesPath } from "./paths";
import { requirePermission } from "./policies";

/**
 * What the organization forms do when they are submitted (M3-3): everything
 * about a Server Action except the two things only Next can do, redirecting
 * and invalidating. ./actions.ts adds those.
 *
 * Each function takes who is asking (from the session, never from the form)
 * and, for an existing organization, the slug from the URL of the page the
 * form is on. That slug says which organization the user MEANS; whether they
 * may act there is decided by the resolver and the services, from their
 * membership. No organization id, role or permission is read from the form.
 *
 * Kept apart from the `"use server"` file so the whole path can be run against
 * a real database in tests, and registered in the isolation suite.
 */

/** Query values the settings page turns into a confirmation after a redirect. */
export const SETTINGS_NOTICES = ["url", "owner"] as const;
export type SettingsNotice = (typeof SETTINGS_NOTICES)[number];
const settingsWithNotice = (orgSlug: string, notice: SettingsNotice) => `${orgSettingsPath(orgSlug)}?changed=${notice}`;

/** Onboarding, step 1: the organization, its Owner (the caller) and its trial, together (`createOrganization`). */
export async function submitCreateOrganization(actor: Actor, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { name: text(formData.get("name")), slug: text(formData.get("slug")) };
  try {
    const organization = await createOrganization(actor, values, meta);
    return { state: { status: "success" }, redirectTo: orgSitesPath(organization.slug), revalidate: pagesOf(organization.slug) };
  } catch (error) {
    return refusal(error, meta, values, ONBOARDING_PATH);
  }
}

export async function submitRenameOrganization(actor: Actor, orgSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { name: text(formData.get("name")) };
  try {
    const ctx = await resolveOrgContext(actor, orgSlug, meta);
    const organization = await updateOrganization(ctx, { name: values.name });
    return {
      state: { status: "success", message: "The organization's name has been updated.", values: { name: organization.name } },
      revalidate: pagesOf(organization.slug),
    };
  } catch (error) {
    return refusal(error, meta, values, orgSettingsPath(orgSlug));
  }
}

/** Changes the organization's slug, which is its URL: on success the browser moves to the new one. */
export async function submitChangeOrganizationSlug(actor: Actor, orgSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { slug: text(formData.get("slug")) };
  try {
    const ctx = await resolveOrgContext(actor, orgSlug, meta);
    const organization = await updateOrganization(ctx, { slug: values.slug });
    if (organization.slug === ctx.org.slug) {
      return { state: { status: "success", message: "That is already this organization's URL.", values: { slug: organization.slug } } };
    }
    return {
      state: { status: "success" },
      redirectTo: settingsWithNotice(organization.slug, "url"),
      revalidate: [...pagesOf(ctx.org.slug), ...pagesOf(organization.slug)],
    };
  } catch (error) {
    return refusal(error, meta, values, orgSettingsPath(orgSlug));
  }
}

/**
 * Hands the organization to another member. The form asks for the member and
 * for the organization's slug typed out, so it cannot be done by one stray
 * click or a replayed request with no thought behind it. Who may do it, to
 * whom, and that an Owner always remains are the service's rules.
 */
export async function submitTransferOwnership(actor: Actor, orgSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const memberId = text(formData.get("memberId"));
  const values = { memberId };
  let inOrganization = false;
  try {
    const ctx = await resolveOrgContext(actor, orgSlug, meta);
    inOrganization = true;
    // Before the input is looked at: someone who may not do this learns nothing from what they typed.
    requirePermission(ctx, "org.manage");
    if (!memberId) throw validationError({ memberId: ["Choose who will become the Owner."] });
    if (text(formData.get("confirm")).trim().toLowerCase() !== ctx.org.slug) {
      throw validationError({ confirm: [`Type ${ctx.org.slug} to confirm.`] });
    }
    await transferOwnership(ctx, { memberId });
    return { state: { status: "success" }, redirectTo: settingsWithNotice(ctx.org.slug, "owner"), revalidate: pagesOf(ctx.org.slug) };
  } catch (error) {
    // Inside the organization, "not found" can only be the member that was named: gone, or never one of its members.
    const messages = inOrganization ? { NotFound: "That person is not a member of this organization. Reload the page and choose again." } : {};
    return refusal(error, meta, values, orgSettingsPath(orgSlug), messages);
  }
}
