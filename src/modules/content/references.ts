import "server-only";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { usableImageIds } from "@/modules/media";
import type { SiteContext } from "@/modules/tenancy";
import { env } from "@/platform/config/env";
import type { TenantTx } from "@/platform/db";
import * as t from "@/platform/db/schema";
import { validationError } from "@/platform/errors";
import { isEmbeddableUrl } from "@/platform/net/url-safety";
import { referencesOf } from "./document/references";
import type { SiteScope } from "./scope";
import { entries } from "./schema";

/**
 * A document may point only at its own site's things (M5-5). The ids in it
 * come from the browser and are checked here, in the caller's transaction:
 *
 *  - saving: every image and every `entry:` link that is NEW in this save
 *    (not in the draft as it was) must be a media item or an entry of this
 *    site that exists now (an image: uploaded and ready). What was already
 *    there is not checked again, so trashing a linked page never makes an
 *    unrelated edit unsavable. The featured image is checked the same way
 *    (`assertUsableImages`, from M6-1, when uploads became real);
 *  - publishing: nothing in the document points at another site of the
 *    organization (another organization's rows are invisible: RLS);
 *  - both: a generic embed never frames Forge's own host.
 */

export const NOT_THIS_SITES_IMAGE = "An image is not one of this site's.";
export const NOT_THIS_SITES_ENTRY = "A link points to a page or post that is not on this site.";
export const SELF_EMBED = "Forge's own pages cannot be embedded.";

const appHost = () => new URL(env("core").APP_ORIGIN).hostname;

function assertEmbeds(embeds: { provider: string; url: string }[]): void {
  const blockedHosts = [appHost()];
  if (embeds.some((embed) => embed.provider === "generic" && !isEmbeddableUrl(embed.url, { blockedHosts }))) throw validationError({ content: [SELF_EMBED] });
}

/**
 * Every id an image of this site that content may newly point at: uploaded and checked (`ready`, M6-1), not
 * trashed, and an image (a PDF is a media item too). A pending upload, a refused one, another site's: refused.
 */
export async function assertUsableImages(tx: TenantTx, ctx: SiteContext, ids: readonly string[], refusal: Record<string, string[]>): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  // The media module's rule (M6-4: behind its API now): this site's, ready, not trashed, an image.
  const usable = await usableImageIds(tx, ctx.org.id, ctx.site.id, unique);
  if (unique.some((id) => !usable.has(id))) throw validationError(refusal);
}

export async function assertNewReferences(tx: TenantTx, ctx: SiteContext, next: unknown, previous: unknown): Promise<void> {
  const now = referencesOf(next);
  const before = referencesOf(previous);
  assertEmbeds(now.embeds);
  await assertUsableImages(tx, ctx, [...now.mediaIds].filter((id) => !before.mediaIds.has(id)), { content: [NOT_THIS_SITES_IMAGE] });
  const linked = [...now.entryIds].filter((id) => !before.entryIds.has(id));
  if (linked.length) {
    const found = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.organizationId, ctx.org.id), eq(entries.siteId, ctx.site.id), inArray(entries.id, linked), isNull(entries.deletedAt)));
    if (found.length !== linked.length) throw validationError({ content: [NOT_THIS_SITES_ENTRY] });
  }
}

export async function assertOwnReferences(tx: TenantTx, ctx: SiteScope, document: unknown): Promise<void> {
  const refs = referencesOf(document);
  assertEmbeds(refs.embeds);
  if (refs.mediaIds.size) {
    const elsewhere = await tx
      .select({ id: t.mediaAssets.id })
      .from(t.mediaAssets)
      .where(and(eq(t.mediaAssets.organizationId, ctx.org.id), ne(t.mediaAssets.siteId, ctx.site.id), inArray(t.mediaAssets.id, [...refs.mediaIds])));
    if (elsewhere.length) throw validationError({ content: [NOT_THIS_SITES_IMAGE] });
  }
  if (refs.entryIds.size) {
    const elsewhere = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.organizationId, ctx.org.id), ne(entries.siteId, ctx.site.id), inArray(entries.id, [...refs.entryIds])));
    if (elsewhere.length) throw validationError({ content: [NOT_THIS_SITES_ENTRY] });
  }
}

/**
 * What an earlier revision points at that is gone now (M7-3: a restore flags it, and keeps the document as it was):
 * image blocks whose image is not usable any more (trashed, deleted, or not ready), and links to pages or posts that
 * are not on the site any more (trashed, or deleted). Another site's, which no revision of this entry can hold, is
 * refused by `assertOwnReferences` first.
 */
export async function missingReferences(tx: TenantTx, ctx: SiteScope, document: unknown): Promise<{ images: number; links: number }> {
  const refs = referencesOf(document);
  const usable = refs.mediaIds.size ? await usableImageIds(tx, ctx.org.id, ctx.site.id, [...refs.mediaIds]) : new Set<string>();
  let links = 0;
  if (refs.entryIds.size) {
    const found = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.organizationId, ctx.org.id), eq(entries.siteId, ctx.site.id), inArray(entries.id, [...refs.entryIds]), isNull(entries.deletedAt)));
    links = refs.entryIds.size - found.length;
  }
  return { images: [...refs.mediaIds].filter((id) => !usable.has(id)).length, links };
}

/**
 * A featured image an earlier revision had (M7-3): usable (`ok`); still this site's but not usable (`unavailable`: in
 * the media trash, kept in the draft as a trashed image already is, and not shown); or gone (`removed`: deleted for
 * good, so the draft cannot point at it, as the foreign key says).
 */
export async function featuredImageState(tx: TenantTx, ctx: SiteScope, mediaId: string): Promise<"ok" | "unavailable" | "removed"> {
  if ((await usableImageIds(tx, ctx.org.id, ctx.site.id, [mediaId])).has(mediaId)) return "ok";
  const [row] = await tx
    .select({ id: t.mediaAssets.id })
    .from(t.mediaAssets)
    .where(and(eq(t.mediaAssets.organizationId, ctx.org.id), eq(t.mediaAssets.siteId, ctx.site.id), eq(t.mediaAssets.id, mediaId)));
  return row ? "unavailable" : "removed";
}
