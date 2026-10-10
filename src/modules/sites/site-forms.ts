import "server-only";
import type { Actor } from "@/modules/auth";
import {
  orgSitesPath, pagesOf, refusal, requirePermission, resolveOrgContext, resolveSiteContext, type FormOutcome, type RequestMeta,
} from "@/modules/tenancy";
import { validationError } from "@/platform/errors";
import { text } from "@/platform/forms";
import { chooseTheme } from "./appearance.service";
import { SOCIAL_KEYS } from "./settings";
import { isSettingsGroup, SETTINGS_CONFLICT, updateSiteSettings, type SettingsGroup } from "./settings.service";
import { notFound } from "@/platform/errors";
import { newSitePath, onboardingThemePath, publicSitePath, siteAppearancePath, sitePath, siteSettingsPath } from "./paths";
import { setSiteStatus } from "./publishing.service";
import { changeSiteAddress, createSite, deleteSite, getSite } from "./sites.service";
import { themeDefinition } from "@/themes/registry";

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
const pagesOfSite = (orgSlug: string, siteSlug: string) => [
  ...pagesOf(orgSlug),
  sitePath(orgSlug, siteSlug),
  siteSettingsPath(orgSlug, siteSlug),
  siteAppearancePath(orgSlug, siteSlug),
];

/** Query values the sites page turns into a confirmation after a redirect (`?done=deleted`). */
export const SITES_NOTICES = ["deleted"] as const;
export type SitesNotice = (typeof SITES_NOTICES)[number];

/**
 * Creates a site from the create-site form (M4-1), on `/{org}/sites/new` or
 * as onboarding's step 2 (M4-2). Only where the browser goes next differs:
 * the site's page, or onboarding's step 3. `flow` is bound by the page; any
 * other value is the admin's.
 */
export async function submitCreateSite(actor: Actor, orgSlug: string, formData: FormData, meta: RequestMeta = {}, flow: string = "admin"): Promise<FormOutcome> {
  const values = {
    name: text(formData.get("name")),
    address: text(formData.get("address")),
    language: text(formData.get("language")),
    timezone: text(formData.get("timezone")),
  };
  try {
    const ctx = await resolveOrgContext(actor, orgSlug, meta);
    const { site, events } = await createSite(ctx, values);
    const next = flow === "onboarding" ? onboardingThemePath(ctx.org.slug, site.slug) : sitePath(ctx.org.slug, site.slug);
    return { state: { status: "success" }, redirectTo: next, revalidate: pagesOfSite(ctx.org.slug, site.slug), invalidate: events };
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

/**
 * Chooses the site's theme (M4-4). The form sends a theme's key and nothing
 * else is read from it: which site, and whether this person may, come from the
 * URL and the session.
 */
export async function submitChooseTheme(actor: Actor, orgSlug: string, siteSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { theme: text(formData.get("theme")) };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { site, changed, events } = await chooseTheme(ctx, values);
    const name = themeDefinition(site.theme)?.name ?? site.theme;
    return {
      state: { status: "success", message: changed ? `The site now uses ${name}.` : `The site already uses ${name}.`, values: { theme: site.theme } },
      revalidate: pagesOfSite(ctx.org.slug, ctx.site.slug),
      invalidate: events,
    };
  } catch (error) {
    return refusal(error, meta, values, siteAppearancePath(orgSlug, siteSlug), {}, MODULE);
  }
}

/**
 * Publishes the site, or switches it back to Coming soon (M4-5). The form
 * sends the status it asks for, so a repeated or late submission asks for
 * the same thing again and changes nothing; the site comes from the URL.
 * The message is written only after the change has been committed.
 */
export async function submitSetSiteStatus(actor: Actor, orgSlug: string, siteSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { status: text(formData.get("status")) };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { site, changed, events } = await setSiteStatus(ctx, values);
    const message =
      site.status === "live"
        ? changed ? `${site.name} is live.` : `${site.name} is already live.`
        : changed ? `${site.name} shows the Coming soon page again.` : `${site.name} already shows the Coming soon page.`;
    return {
      state: { status: "success", message, values: { status: site.status } },
      revalidate: pagesOfSite(ctx.org.slug, ctx.site.slug),
      invalidate: events,
    };
  } catch (error) {
    return refusal(error, meta, values, sitePath(orgSlug, siteSlug), {}, MODULE);
  }
}

/** The fields each settings form sends, and nothing else is read from it. */
const SETTINGS_FIELDS: Record<SettingsGroup, readonly string[]> = {
  general: ["name", "tagline", "language", "timezone", ...SOCIAL_KEYS],
  reading: ["blogPath", "postsPerPage"],
  analytics: ["ga4MeasurementId", "plausibleDomain"],
};
const SAVED: Record<SettingsGroup, string> = { general: "General settings saved.", reading: "Reading settings saved.", analytics: "Analytics settings saved." };

/**
 * Saves one group of the site's settings (M4-2). The group is bound by the
 * page; the site and the permission come from the URL and the session. The
 * form's `version` is the one its page was rendered with: a save over
 * someone else's newer one is refused and changes nothing.
 */
export async function submitUpdateSiteSettings(
  actor: Actor,
  orgSlug: string,
  siteSlug: string,
  group: string,
  formData: FormData,
  meta: RequestMeta = {},
): Promise<FormOutcome> {
  const fields = isSettingsGroup(group) ? SETTINGS_FIELDS[group] : [];
  const values = Object.fromEntries(fields.map((field) => [field, text(formData.get(field))]));
  try {
    if (!isSettingsGroup(group)) throw notFound();
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    // The version is a whole number as the page wrote it, or no version at all: a save without one cannot win.
    const raw = text(formData.get("version"));
    const version = /^\d{1,9}$/.test(raw) ? Number(raw) : -1;
    const { changed, events } = await updateSiteSettings(ctx, group, values, version);
    return {
      state: { status: "success", message: changed.length > 0 ? SAVED[group] : "Nothing to save: these are already the site’s settings.", values },
      ...(changed.length > 0 ? { revalidate: pagesOfSite(ctx.org.slug, ctx.site.slug), invalidate: events } : {}),
    };
  } catch (error) {
    return refusal(error, meta, values, siteSettingsPath(orgSlug, siteSlug), { Conflict: SETTINGS_CONFLICT }, MODULE);
  }
}
