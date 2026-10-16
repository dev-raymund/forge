import "server-only";
import { z } from "zod";
import { inTenant, type SiteContext } from "@/modules/tenancy";
import { AppError, notFound } from "@/platform/errors";
import { PREVIEW_PATH_PREFIX, PREVIEW_TOKEN_TTL_SECONDS, previewSecret, signPreviewToken } from "@/platform/routing/preview-token";
import { refOf } from "./entry.service";
import { canSeeEntry } from "./policies";
import { findEntry, fullRevision } from "./repository";

/**
 * Preview links (M7-4; plan §9 "Preview"; ADR 0027): `/_forge/preview/{token}` for an entry's draft, or for one of its
 * revisions (the history's preview). Whoever may see the entry may preview it (plan §9: "read"): the same rule as the
 * editor and the history, so an Author gets no link to a page or to another Author's post (not found, as an entry of
 * another site), and a revision is looked up in that entry. The token names the organization, the site, the entry,
 * the user and the revision, and lasts 15 minutes; the page it opens checks all of it again, and the user's rights as
 * they are then. Read-only: nothing is written, recorded or flushed.
 */

export type PreviewLink = { path: string; expiresAt: string };

export const PREVIEWS_OFF = "Previews are not set up on this server yet.";

export async function createPreviewLink(ctx: SiteContext, entryId: string, options: { revisionId?: unknown } = {}): Promise<PreviewLink> {
  const secret = previewSecret();
  if (!secret) throw new AppError("Unavailable", PREVIEWS_OFF);
  let revisionId: string | null = null;
  if (options.revisionId !== undefined && options.revisionId !== null && options.revisionId !== "") {
    const parsed = z.uuid().safeParse(options.revisionId);
    if (!parsed.success) throw notFound();
    revisionId = parsed.data;
  }
  return inTenant(ctx, async (tx) => {
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId);
    if (!entry || !canSeeEntry(ctx, refOf(entry))) throw notFound();
    if (revisionId && !(await fullRevision(tx, ctx.org.id, ctx.site.id, entry.id, revisionId))) throw notFound();
    const expiresAt = Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_TTL_SECONDS;
    const token = signPreviewToken({ orgId: ctx.org.id, siteId: ctx.site.id, entryId: entry.id, userId: ctx.actor.userId, revisionId, expiresAt }, secret);
    return { path: `${PREVIEW_PATH_PREFIX}/${token}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
  });
}
