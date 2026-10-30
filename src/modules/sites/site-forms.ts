import "server-only";
import type { Actor } from "@/modules/auth";
import {
  orgSitesPath, pagesOf, refusal, requirePermission, resolveOrgContext, resolveSiteContext, type FormOutcome, type RequestMeta,
} from "@/modules/tenancy";
import { actionOk, asAppError, toActionResult, validationError, type ActionResult } from "@/platform/errors";
import { reportError } from "@/platform/observability";
import { text } from "@/platform/forms";
import { chooseTheme, createAppearancePreview, updateAppearance } from "./appearance.service";
import { SOCIAL_KEYS } from "./settings";
import { isSettingsGroup, SETTINGS_CONFLICT, updateSiteSettings, type SettingsGroup } from "./settings.service";
import { notFound } from "@/platform/errors";
import { newSitePath, onboardingThemePath, publicSitePath, siteAppearancePath, sitePath, siteSeoPath, siteSettingsPath } from "./paths";
import { updateSeoSettings } from "./seo-settings.service";
import { isSiteImageRole, setSiteImage } from "./imagery.service";
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
    const { changed, redirects, events } = await updateSiteSettings(ctx, group, values, version);
    // A new blog path (M8-5): say where its old addresses go.
    const moved = redirects.made.length
      ? ` The blog's old address ${redirects.made[0]!.source} and its archives redirect to the new ones; each post stays at its address until it is published again.`
      : "";
    return {
      state: { status: "success", message: changed.length > 0 ? `${SAVED[group]}${moved}` : "Nothing to save: these are already the site’s settings.", values },
      ...(changed.length > 0 ? { revalidate: pagesOfSite(ctx.org.slug, ctx.site.slug), invalidate: events } : {}),
    };
  } catch (error) {
    return refusal(error, meta, values, siteSettingsPath(orgSlug, siteSlug), { Conflict: SETTINGS_CONFLICT }, MODULE);
  }
}

const IMAGE_SAVED = { logo: { set: "Logo saved.", removed: "Logo removed." }, favicon: { set: "Favicon saved.", removed: "Favicon removed." } } as const;

/**
 * Sets or removes the site's logo or favicon (M6-4). The role is bound by the page; the form sends `mediaId`, or
 * nothing to remove. Which site, whether the caller may, and whether the image may be used are the server's to decide.
 */
export async function submitSetSiteImage(actor: Actor, orgSlug: string, siteSlug: string, role: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const mediaId = text(formData.get("mediaId")) || null;
  const values = { mediaId: mediaId ?? "" };
  try {
    if (!isSiteImageRole(role)) throw notFound();
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { changed, events } = await setSiteImage(ctx, role, mediaId);
    return {
      state: { status: "success", message: changed ? IMAGE_SAVED[role][mediaId ? "set" : "removed"] : `Nothing to save: this is already the site’s ${role}.`, values },
      ...(changed ? { revalidate: pagesOfSite(ctx.org.slug, ctx.site.slug), invalidate: events } : {}),
    };
  } catch (error) {
    return refusal(error, meta, values, siteSettingsPath(orgSlug, siteSlug), {}, MODULE);
  }
}

// ── M8-1: the appearance editor ──────────────────────────────────────────────

/** The editor sends its settings as JSON (`settings`); they are a few hundred bytes, so anything far larger is not them. */
const APPEARANCE_FIELD_MAX = 8_000;

function appearanceFrom(formData: FormData): unknown {
  const raw = text(formData.get("settings"));
  if (raw.length > APPEARANCE_FIELD_MAX) throw validationError({ settings: ["These settings could not be read. Reload the page and try again."] });
  try {
    return JSON.parse(raw);
  } catch {
    throw validationError({ settings: ["These settings could not be read. Reload the page and try again."] });
  }
}

/** Saves the site's theme settings at `version` (the page's). Field errors come back keyed by the setting's dotted path. */
export async function submitUpdateAppearance(actor: Actor, orgSlug: string, siteSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { version: text(formData.get("version")) };
  try {
    const settings = appearanceFrom(formData);
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const version = /^\d{1,9}$/.test(values.version) ? Number(values.version) : -1;
    const saved = await updateAppearance(ctx, settings, version);
    return {
      state: {
        status: "success",
        message: saved.changed.length ? "Appearance saved. The site shows it now." : "Nothing to save: this is already the site’s appearance.",
        values: { version: String(saved.version) },
      },
      ...(saved.changed.length ? { revalidate: pagesOfSite(ctx.org.slug, ctx.site.slug), invalidate: saved.events } : {}),
      refresh: false,
    };
  } catch (error) {
    return refusal(error, meta, values, siteAppearancePath(orgSlug, siteSlug), { Conflict: SETTINGS_CONFLICT }, MODULE);
  }
}

/** Saves the site's SEO defaults (M8-4) at `version` (the page's). Field errors come back keyed by the setting. */
export async function submitUpdateSeoSettings(actor: Actor, orgSlug: string, siteSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { version: text(formData.get("version")) };
  try {
    const raw = text(formData.get("seo"));
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw validationError({ seo: ["These settings could not be read. Reload the page and try again."] });
    }
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const version = /^\d{1,9}$/.test(values.version) ? Number(values.version) : -1;
    const saved = await updateSeoSettings(ctx, input, version);
    return {
      state: {
        status: "success",
        message: saved.changed.length ? "SEO settings saved. The site uses them now." : "Nothing to save: these are already the site’s SEO settings.",
        values: { version: String(saved.version) },
      },
      ...(saved.changed.length ? { revalidate: pagesOfSite(ctx.org.slug, ctx.site.slug), invalidate: saved.events } : {}),
      refresh: false,
    };
  } catch (error) {
    return refusal(error, meta, values, siteSeoPath(orgSlug, siteSlug), { Conflict: SETTINGS_CONFLICT }, MODULE);
  }
}

/** A preview link for settings that are not saved. Read-only. */
export async function submitAppearancePreview(actor: Actor, orgSlug: string, siteSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<ActionResult<{ path: string; expiresAt: string }>> {
  try {
    const settings = appearanceFrom(formData);
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    return actionOk(await createAppearancePreview(ctx, settings));
  } catch (error) {
    if (!asAppError(error)) reportError(error, { module: MODULE, requestId: meta.requestId });
    return toActionResult(error, meta.requestId);
  }
}
