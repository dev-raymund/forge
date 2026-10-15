import "server-only";
import { actionOk, asAppError, toActionResult, type ActionResult } from "@/platform/errors";
import { reportError } from "@/platform/observability";
import type { Actor } from "@/modules/auth";
import { sitePath } from "@/modules/sites/shared";
import { refusal, resolveSiteContext, type FormOutcome, type RequestMeta } from "@/modules/tenancy";
import { text } from "@/platform/forms";
import { createFolder, deleteFolder, mediaUsage, moveMedia, renameFolder, restoreMedia, trashMedia, updateMediaDetails, type MediaUsage } from "./library.service";

/**
 * What the media library's forms and buttons do (M6-3): everything about a Server Action except flushing and
 * re-rendering, which ./actions.ts adds. Who is asking comes from the session; the organization and the site from the
 * page's URL; the media and folder ids are bound by the page. They name things and grant nothing: the services look
 * them up in the context's site and ask for the permission.
 */

const MODULE = "media";
export const mediaLibraryPath = (orgSlug: string, siteSlug: string) => `${sitePath(orgSlug, siteSlug)}/media`;

const done = (orgSlug: string, siteSlug: string, message: string, extra: Partial<FormOutcome> = {}): FormOutcome => ({
  state: { status: "success", message },
  revalidate: [mediaLibraryPath(orgSlug, siteSlug)],
  ...extra,
});

export async function submitUpdateMedia(actor: Actor, orgSlug: string, siteSlug: string, mediaId: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const field = (name: string) => (formData.has(name) ? text(formData.get(name)) : undefined);
  const values = { title: field("title"), altText: field("altText"), caption: field("caption") };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { changed, events } = await updateMediaDetails(ctx, mediaId, values);
    return done(ctx.org.slug, ctx.site.slug, changed ? "Details saved." : "Nothing changed.", { invalidate: events });
  } catch (error) {
    return refusal(error, meta, Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<string, string>, mediaLibraryPath(orgSlug, siteSlug), {}, MODULE);
  }
}

export async function submitMoveMedia(actor: Actor, orgSlug: string, siteSlug: string, mediaIds: unknown, folderId: unknown, meta: RequestMeta = {}): Promise<FormOutcome> {
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { moved } = await moveMedia(ctx, mediaIds, folderId === "" ? null : folderId);
    return done(ctx.org.slug, ctx.site.slug, moved ? `${moved} ${moved === 1 ? "file" : "files"} moved.` : "Already there.");
  } catch (error) {
    return refusal(error, meta, {}, mediaLibraryPath(orgSlug, siteSlug), {}, MODULE);
  }
}

export async function submitTrashMedia(actor: Actor, orgSlug: string, siteSlug: string, mediaId: string, meta: RequestMeta = {}): Promise<FormOutcome> {
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { events, usage } = await trashMedia(ctx, mediaId);
    const shown = usage?.published ?? 0;
    const where = shown ? ` ${shown} published ${shown === 1 ? "page or post no longer shows" : "pages and posts no longer show"} it.` : "";
    return done(ctx.org.slug, ctx.site.slug, `Moved to the trash.${where} It can be restored for 30 days.`, { invalidate: events });
  } catch (error) {
    return refusal(error, meta, {}, mediaLibraryPath(orgSlug, siteSlug), {}, MODULE);
  }
}

export async function submitRestoreMedia(actor: Actor, orgSlug: string, siteSlug: string, mediaId: string, meta: RequestMeta = {}): Promise<FormOutcome> {
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { events } = await restoreMedia(ctx, mediaId);
    return done(ctx.org.slug, ctx.site.slug, "Restored.", { invalidate: events });
  } catch (error) {
    return refusal(error, meta, {}, mediaLibraryPath(orgSlug, siteSlug), {}, MODULE);
  }
}

export async function submitCreateFolder(actor: Actor, orgSlug: string, siteSlug: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { name: text(formData.get("name")) };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { folder } = await createFolder(ctx, values);
    return done(ctx.org.slug, ctx.site.slug, `Folder ${folder.name} created.`, { state: { status: "success", message: `Folder ${folder.name} created.`, values: { folderId: folder.id } } });
  } catch (error) {
    return refusal(error, meta, values, mediaLibraryPath(orgSlug, siteSlug), {}, MODULE);
  }
}

export async function submitRenameFolder(actor: Actor, orgSlug: string, siteSlug: string, folderId: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { name: text(formData.get("name")) };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { changed } = await renameFolder(ctx, folderId, values);
    return done(ctx.org.slug, ctx.site.slug, changed ? "Folder renamed." : "Nothing changed.");
  } catch (error) {
    return refusal(error, meta, values, mediaLibraryPath(orgSlug, siteSlug), {}, MODULE);
  }
}

export async function submitDeleteFolder(actor: Actor, orgSlug: string, siteSlug: string, folderId: string, meta: RequestMeta = {}): Promise<FormOutcome> {
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    await deleteFolder(ctx, folderId);
    return done(ctx.org.slug, ctx.site.slug, "Folder deleted.");
  } catch (error) {
    return refusal(error, meta, {}, mediaLibraryPath(orgSlug, siteSlug), {}, MODULE);
  }
}

/**
 * Where a file is used (M7-1): what the drawer says before it is moved to the trash. Read-only; the trash itself checks
 * again, and reports what it found.
 */
export async function submitMediaUsage(actor: Actor, orgSlug: string, siteSlug: string, mediaId: unknown, meta: RequestMeta = {}): Promise<ActionResult<MediaUsage>> {
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    return actionOk(await mediaUsage(ctx, mediaId));
  } catch (error) {
    if (!asAppError(error)) reportError(error, { module: MODULE, requestId: meta.requestId });
    return toActionResult(error, meta.requestId);
  }
}
