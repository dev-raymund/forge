import "server-only";
import { z } from "zod";
import type { Actor } from "@/modules/auth";
import { sitePath } from "@/modules/sites/shared";
import { refusal, resolveSiteContext, type FormOutcome, type RequestMeta } from "@/modules/tenancy";
import { notFound, validationError } from "@/platform/errors";
import { text } from "@/platform/forms";
import { createEntry, saveDraft } from "./entry.service";
import { setHomepage } from "./homepage.service";
import { publishEntry } from "./publishing.service";
import { contentType } from "./types/registry";
import { versionSchema } from "./validation";

/**
 * What the entry forms do when they are submitted (M5-3): everything about a
 * Server Action except flushing and redirecting, which ./actions.ts adds. The
 * screens are M5-4's (editor) and M5-7's (lists, new forms, sidebar).
 *
 * Who is asking comes from the session; the organization and the site from
 * the URL of the page; the entry's id and the type are bound by that page.
 * They name things and grant nothing: the services look the entry up in the
 * context's site and ask for the permission. No organization id, site id,
 * role or permission is read from the form.
 */

const MODULE = "content";

/** A form's draft field (JSON) may be at most this long before it is even parsed: a little over the 1 MB document limit. */
export const DRAFT_FIELD_MAX = 1_200_000;

const isUuid = (value: string) => z.uuid().safeParse(value).success;
/** An entry id from the URL that is not even an id names nothing: the same answer as an id of another site. */
function entryIdFrom(value: string): string {
  if (!isUuid(value)) throw notFound();
  return value;
}
function versionFrom(value: string): number {
  const parsed = versionSchema.safeParse(value);
  if (!parsed.success) throw validationError({ version: ["Reload the page and try again."] });
  return parsed.data;
}

/** Creates a page or a post (the type is bound by the page: `/…/pages/new` or `/…/posts/new`). */
export async function submitCreateEntry(actor: Actor, orgSlug: string, siteSlug: string, type: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { title: text(formData.get("title")), parentId: text(formData.get("parentId")), template: text(formData.get("template")), authorId: text(formData.get("authorId")) };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { entry, events } = await createEntry(ctx, {
      type, title: values.title, parentId: values.parentId || null, template: values.template || null, authorId: values.authorId || null,
    });
    return {
      state: { status: "success", message: `${contentType(entry.type)!.label.singular} created.`, values: { entryId: entry.id, title: entry.title, path: entry.path } },
      revalidate: [sitePath(ctx.org.slug, ctx.site.slug)],
      invalidate: events,
    };
  } catch (error) {
    return refusal(error, meta, values, sitePath(orgSlug, siteSlug), {}, MODULE);
  }
}

/** Saves the draft: `version` (the one the editor started from) and `draft` (JSON: the fields being changed). */
export async function submitSaveDraft(actor: Actor, orgSlug: string, siteSlug: string, entryId: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const version = text(formData.get("version"));
  // The draft is not echoed back: it can be a megabyte, and the editor has it.
  const values = { version };
  try {
    const id = entryIdFrom(entryId);
    const raw = text(formData.get("draft"));
    if (raw.length > DRAFT_FIELD_MAX) throw validationError({ content: ["This content is too large to save (the limit is 1 MB)."] });
    let draft: unknown;
    try {
      draft = JSON.parse(raw);
    } catch {
      throw validationError({ draft: ["The draft could not be read. Reload the page and try again."] });
    }
    const expected = versionFrom(version);
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const saved = await saveDraft(ctx, id, expected, draft as Parameters<typeof saveDraft>[3]);
    // Autosave runs every few seconds: the editor holds the draft, so the page is not rendered again for it.
    return { state: { status: "success", values: { version: String(saved.version) } }, refresh: false };
  } catch (error) {
    return refusal(error, meta, values, sitePath(orgSlug, siteSlug), {}, MODULE);
  }
}

/** Publishes the draft at `version`. A repeat of the same publish answers as the first one did. */
export async function submitPublishEntry(actor: Actor, orgSlug: string, siteSlug: string, entryId: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { version: text(formData.get("version")) };
  try {
    const id = entryIdFrom(entryId);
    const expected = versionFrom(values.version);
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const published = await publishEntry(ctx, id, expected);
    return {
      state: {
        status: "success",
        message: published.changed ? "Published." : "Already published.",
        values: { path: published.entry.path, revision: String(published.revision) },
      },
      revalidate: [sitePath(ctx.org.slug, ctx.site.slug)],
      invalidate: published.events,
    };
  } catch (error) {
    return refusal(error, meta, values, sitePath(orgSlug, siteSlug), {}, MODULE);
  }
}

/** Makes the page the site's home page. */
export async function submitSetHomepage(actor: Actor, orgSlug: string, siteSlug: string, entryId: string, _formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  try {
    const id = entryIdFrom(entryId);
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { changed, events } = await setHomepage(ctx, id);
    return {
      state: { status: "success", message: changed ? "This page is now the home page." : "This page is already the home page." },
      revalidate: [sitePath(ctx.org.slug, ctx.site.slug)],
      invalidate: events,
    };
  } catch (error) {
    return refusal(error, meta, {}, sitePath(orgSlug, siteSlug), {}, MODULE);
  }
}
