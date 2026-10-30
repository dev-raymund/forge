import "server-only";
import type { Actor } from "@/modules/auth";
import { refusal, resolveSiteContext, type FormOutcome, type RequestMeta } from "@/modules/tenancy";
import { text } from "@/platform/forms";
import { siteRedirectsPath } from "./paths";
import { createRedirect, deleteRedirect, setNotFoundPage, updateRedirect } from "./redirects.service";

/**
 * What the redirects page's forms do when they are submitted (M8-5). Who is asking comes from the session; the
 * organization and the site from the page's URL; a redirect's id from the row the page drew. They name things and
 * grant nothing: the service asks for the permission and looks the redirect up in the context's site only (another
 * site's id is "not found").
 *
 * A success shows the server's answer (what was stored, and any chain it shortened) and draws the list again.
 */

const MODULE = "seo";

const flag = (value: FormDataEntryValue | null): boolean | undefined => (value === "true" ? true : value === "false" ? false : undefined);
const optional = (value: FormDataEntryValue | null): string | undefined => (value === null ? undefined : text(value));

export async function submitCreateRedirect(actor: Actor, orgSlug: string, siteSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { source: text(formData.get("source")), destination: text(formData.get("destination")), statusCode: text(formData.get("statusCode")) };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const saved = await createRedirect(ctx, { source: values.source, destination: values.destination, statusCode: values.statusCode || "301" });
    return {
      state: {
        status: "success",
        message: [`Redirect added: ${saved.redirect.source} now goes to ${saved.redirect.destination}.`, ...saved.notes].join(" "),
        values: { id: saved.redirect.id, source: saved.redirect.source, destination: saved.redirect.destination },
      },
      revalidate: [siteRedirectsPath(ctx.org.slug, ctx.site.slug)],
      invalidate: saved.events,
    };
  } catch (error) {
    return refusal(error, meta, values, siteRedirectsPath(orgSlug, siteSlug), {}, MODULE);
  }
}

export async function submitUpdateRedirect(actor: Actor, orgSlug: string, siteSlug: string, redirectId: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { destination: optional(formData.get("destination")) ?? "", statusCode: optional(formData.get("statusCode")) ?? "" };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const input = {
      ...(formData.has("destination") ? { destination: values.destination } : {}),
      ...(formData.has("statusCode") ? { statusCode: values.statusCode } : {}),
      ...(flag(formData.get("isActive")) !== undefined ? { isActive: flag(formData.get("isActive")) } : {}),
    };
    const saved = await updateRedirect(ctx, redirectId, input);
    const what = !saved.changed
      ? "Nothing to change: the redirect is already like that."
      : "isActive" in input && Object.keys(input).length === 1
        ? saved.redirect.isActive
          ? `The redirect from ${saved.redirect.source} is on.`
          : `The redirect from ${saved.redirect.source} is off: the address answers "not found" until it is on again.`
        : `Redirect saved: ${saved.redirect.source} goes to ${saved.redirect.destination}.`;
    return {
      state: { status: "success", message: [what, ...saved.notes].join(" "), values: { destination: saved.redirect.destination, statusCode: String(saved.redirect.statusCode) } },
      ...(saved.changed ? { revalidate: [siteRedirectsPath(ctx.org.slug, ctx.site.slug)], invalidate: saved.events } : {}),
    };
  } catch (error) {
    return refusal(error, meta, values, siteRedirectsPath(orgSlug, siteSlug), {}, MODULE);
  }
}

export async function submitDeleteRedirect(actor: Actor, orgSlug: string, siteSlug: string, redirectId: string, _formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { source, events } = await deleteRedirect(ctx, redirectId);
    return {
      state: { status: "success", message: `Redirect deleted: ${source} answers "not found" again.` },
      revalidate: [siteRedirectsPath(ctx.org.slug, ctx.site.slug)],
      invalidate: events,
    };
  } catch (error) {
    return refusal(error, meta, {}, siteRedirectsPath(orgSlug, siteSlug), {}, MODULE);
  }
}

export async function submitSetNotFoundPage(actor: Actor, orgSlug: string, siteSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { entryId: text(formData.get("entryId")) };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { changed, events } = await setNotFoundPage(ctx, values.entryId || null);
    return {
      state: {
        status: "success",
        message: !changed
          ? "Nothing to change."
          : values.entryId
            ? "Not-found page saved. Addresses the site does not have show it now, as “not found”."
            : "The site shows the theme's own not-found page again.",
      },
      ...(changed ? { revalidate: [siteRedirectsPath(ctx.org.slug, ctx.site.slug)], invalidate: events } : {}),
    };
  } catch (error) {
    return refusal(error, meta, values, siteRedirectsPath(orgSlug, siteSlug), {}, MODULE);
  }
}
