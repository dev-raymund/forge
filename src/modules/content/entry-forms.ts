import "server-only";
import { z } from "zod";
import type { Actor } from "@/modules/auth";
import { sitePath } from "@/modules/sites/shared";
import { refusal, resolveSiteContext, type FormOutcome, type RequestMeta } from "@/modules/tenancy";
import { forbidden, notFound, validationError } from "@/platform/errors";
import { text } from "@/platform/forms";
import { entryEditorPath } from "./admin-paths";
import { changeAuthor, createEntry, saveDraft } from "./entry.service";
import { setHomepage } from "./homepage.service";
import { canSetHomepage } from "./policies";
import { publishEntry } from "./publishing.service";
import { movePage, placePage } from "./tree.service";
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

/**
 * Creates a page or a post (the type is bound by the page: `/…/pages/new` or `/…/posts/new`) and opens its editor
 * (M5-7). `home=on` (a page, for those who may set the homepage) makes the new page the site's home page as well:
 * `setHomepage` right after `createEntry`, each in its own transaction, so a refusal of the second still leaves the
 * page, which the editor then opens. Who may set the homepage is asked first, so nobody creates a page only to be
 * told no.
 */
export async function submitCreateEntry(actor: Actor, orgSlug: string, siteSlug: string, type: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = {
    title: text(formData.get("title")), parentId: text(formData.get("parentId")), template: text(formData.get("template")), authorId: text(formData.get("authorId")),
    home: text(formData.get("home")),
  };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const makeHome = values.home === "on" && type === "page";
    if (makeHome && !canSetHomepage(ctx)) throw forbidden();
    const { entry, events } = await createEntry(ctx, {
      type, title: values.title, parentId: values.parentId || null, template: values.template || null, authorId: values.authorId || null,
    });
    const home = makeHome ? await setHomepage(ctx, entry.id) : null;
    return {
      state: { status: "success", message: `${contentType(entry.type)!.label.singular} created.`, values: { entryId: entry.id, title: entry.title, path: home ? "/" : entry.path } },
      redirectTo: entryEditorPath(ctx.org.slug, ctx.site.slug, entry.type, entry.id),
      revalidate: [sitePath(ctx.org.slug, ctx.site.slug)],
      invalidate: [...events, ...(home?.events ?? [])],
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
      // The screen that asked updates itself (the editor keeps its draft and its autosave; the page tree refreshes):
      // a refresh under an open editor could hand it a draft version older than its own.
      refresh: false,
    };
  } catch (error) {
    return refusal(error, meta, {}, sitePath(orgSlug, siteSlug), {}, MODULE);
  }
}

// ── M5-7: the page tree and the author ────────────────────────────────────────

/** An id from the form, or null for "none": anything else is not an id of anything, and is refused as such. */
function optionalIdFrom(value: string, field: string, message: string): string | null {
  if (value === "") return null;
  if (!isUuid(value)) throw validationError({ [field]: [message] });
  return value;
}

/** Puts a page under another page (`parentId`; empty: the top level). Its address and those of the pages below it follow. */
export async function submitMovePage(actor: Actor, orgSlug: string, siteSlug: string, entryId: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { parentId: text(formData.get("parentId")) };
  try {
    const id = entryIdFrom(entryId);
    const parentId = optionalIdFrom(values.parentId, "parentId", "Choose a page of this site.");
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { entry, changed, moved, events } = await movePage(ctx, id, parentId);
    const below = moved.filter((page) => page.id !== entry.id).length;
    return {
      state: {
        status: "success",
        message: !changed ? "The page is already there." : below ? `Page moved, with ${below} ${below === 1 ? "page" : "pages"} below it.` : "Page moved.",
        values: { path: entry.path, parentId: entry.parentId ?? "" },
      },
      revalidate: [sitePath(ctx.org.slug, ctx.site.slug)],
      invalidate: events,
      // The screen that asked updates itself (the editor keeps its draft and its autosave; the page tree refreshes):
      // a refresh under an open editor could hand it a draft version older than its own.
      refresh: false,
    };
  } catch (error) {
    return refusal(error, meta, values, sitePath(orgSlug, siteSlug), {}, MODULE);
  }
}

/** Puts a page among its siblings: before `beforeId`, or last when it is empty. */
export async function submitPlacePage(actor: Actor, orgSlug: string, siteSlug: string, entryId: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { beforeId: text(formData.get("beforeId")) };
  try {
    const id = entryIdFrom(entryId);
    const beforeId = optionalIdFrom(values.beforeId, "beforeId", "Choose a page at the same level.");
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { changed, position, events } = await placePage(ctx, id, beforeId);
    return {
      state: { status: "success", message: changed ? `Moved to position ${position}.` : "The page is already there.", values: { position: String(position) } },
      revalidate: [sitePath(ctx.org.slug, ctx.site.slug)],
      invalidate: events,
      // The screen that asked updates itself (the editor keeps its draft and its autosave; the page tree refreshes):
      // a refresh under an open editor could hand it a draft version older than its own.
      refresh: false,
    };
  } catch (error) {
    return refusal(error, meta, values, sitePath(orgSlug, siteSlug), {}, MODULE);
  }
}

/** Credits the entry to another member (`authorId`, a user of the organization). */
export async function submitChangeAuthor(actor: Actor, orgSlug: string, siteSlug: string, entryId: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { authorId: text(formData.get("authorId")) };
  try {
    const id = entryIdFrom(entryId);
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { changed, events } = await changeAuthor(ctx, id, values.authorId);
    return {
      state: { status: "success", message: changed ? "Author changed." : "That is already the author.", values },
      revalidate: [sitePath(ctx.org.slug, ctx.site.slug)],
      invalidate: events,
      // The screen that asked updates itself (the editor keeps its draft and its autosave; the page tree refreshes):
      // a refresh under an open editor could hand it a draft version older than its own.
      refresh: false,
    };
  } catch (error) {
    return refusal(error, meta, values, sitePath(orgSlug, siteSlug), {}, MODULE);
  }
}
