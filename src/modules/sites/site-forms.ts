import "server-only";
import type { Actor } from "@/modules/auth";
import {
  orgSitesPath, pagesOf, refusal, requirePermission, resolveOrgContext, resolveSiteContext, type FormOutcome, type RequestMeta,
} from "@/modules/tenancy";
import { validationError } from "@/platform/errors";
import { text } from "@/platform/forms";
import { newSitePath, publicSitePath, sitePath, siteSettingsPath } from "./paths";
import { changeSiteAddress, createSite, deleteSite, getSite } from "./sites.service";

/**
 * What the site forms do when they are submitted (M4-1): everything about a
 * Server Action except redirecting and invalidating, which ./actions.ts adds.
 *
 * Who is asking comes from the session; which organization and which site
 * they mean comes from the URL of the page the form is on. The resolver and
 * the services decide whether they may. No organization id, site id, role or
 * permission is read from the form.
 *
 * Kept apart from the `"use server"` file so the whole path runs against a
 * real database in tests, and is registered in the isolation suite.
 */

const MODULE = "sites";

/** Admin pages that show a site: the organization's (its list, its activity) and the site's own. */
const pagesOfSite = (orgSlug: string, siteSlug: string) => [...pagesOf(orgSlug), sitePath(orgSlug, siteSlug), siteSettingsPath(orgSlug, siteSlug)];

/** Query values the sites page turns into a confirmation after a redirect (`?done=deleted`). */
export const SITES_NOTICES = ["deleted"] as const;
export type SitesNotice = (typeof SITES_NOTICES)[number];

export async function submitCreateSite(actor: Actor, orgSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = {
    name: text(formData.get("name")),
    address: text(formData.get("address")),
    language: text(formData.get("language")),
    timezone: text(formData.get("timezone")),
  };
  try {
    const ctx = await resolveOrgContext(actor, orgSlug, meta);
    const { site, events } = await createSite(ctx, values);
    return { state: { status: "success" }, redirectTo: sitePath(ctx.org.slug, site.slug), revalidate: pagesOfSite(ctx.org.slug, site.slug), invalidate: events };
  } catch (error) {
    return refusal(error, meta, values, newSitePath(orgSlug), {}, MODULE);
  }
}

export async function submitChangeSiteAddress(actor: Actor, orgSlug: string, siteSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { address: text(formData.get("address")) };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { site, changed, events } = await changeSiteAddress(ctx, values);
    const address = site.address ?? values.address;
    return {
      state: {
        status: "success",
        message: changed ? `The site is now at ${publicSitePath(address)}.` : "That is already the site’s address.",
        values: { address },
      },
      revalidate: pagesOfSite(ctx.org.slug, ctx.site.slug),
      invalidate: events,
    };
  } catch (error) {
    return refusal(error, meta, values, siteSettingsPath(orgSlug, siteSlug), {}, MODULE);
  }
}

/**
 * Deletes the site. The form asks for the site's address typed out, so it
 * cannot be done by one stray click or a replayed request with no thought
 * behind it. Who may do it is the service's rule (Owners).
 */
export async function submitDeleteSite(actor: Actor, orgSlug: string, siteSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    // Before the input is looked at: someone who may not do this learns nothing from what they typed.
    requirePermission(ctx, "sites.delete");
    const site = await getSite(ctx);
    const expected = site.address ?? site.slug;
    if (text(formData.get("confirm")).trim().toLowerCase() !== expected) throw validationError({ confirm: [`Type ${expected} to confirm.`] });
    const { events } = await deleteSite(ctx);
    return {
      state: { status: "success" },
      redirectTo: `${orgSitesPath(ctx.org.slug)}?done=deleted`,
      revalidate: pagesOfSite(ctx.org.slug, ctx.site.slug),
      invalidate: events,
    };
  } catch (error) {
    return refusal(error, meta, {}, siteSettingsPath(orgSlug, siteSlug), {}, MODULE);
  }
}
