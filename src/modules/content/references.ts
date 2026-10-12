import "server-only";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { SiteContext } from "@/modules/tenancy";
import { env } from "@/platform/config/env";
import type { TenantTx } from "@/platform/db";
import * as t from "@/platform/db/schema";
import { validationError } from "@/platform/errors";
import { isEmbeddableUrl } from "@/platform/net/url-safety";
import { referencesOf } from "./document/references";
import { entries } from "./schema";

/**
 * A document may point only at its own site's things (M5-5). The ids in it
 * come from the browser and are checked here, in the caller's transaction:
 *
 *  - saving: every image and every `entry:` link that is NEW in this save
 *    (not in the draft as it was) must be a media item or an entry of this
 *    site that exists now (an image: uploaded and ready). What was already
 *    there is not checked again, so trashing a linked page never makes an
 *    unrelated edit unsavable;
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

export async function assertNewReferences(tx: TenantTx, ctx: SiteContext, next: unknown, previous: unknown): Promise<void> {
  const now = referencesOf(next);
  const before = referencesOf(previous);
  assertEmbeds(now.embeds);
  const media = [...now.mediaIds].filter((id) => !before.mediaIds.has(id));
  if (media.length) {
    const found = await tx
      .select({ id: t.mediaAssets.id })
      .from(t.mediaAssets)
      .where(
        and(
          eq(t.mediaAssets.organizationId, ctx.org.id),
          eq(t.mediaAssets.siteId, ctx.site.id),
          inArray(t.mediaAssets.id, media),
          isNull(t.mediaAssets.deletedAt),
          eq(t.mediaAssets.status, "ready"),
        ),
      );
    if (found.length !== media.length) throw validationError({ content: [NOT_THIS_SITES_IMAGE] });
  }
  const linked = [...now.entryIds].filter((id) => !before.entryIds.has(id));
  if (linked.length) {
    const found = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.organizationId, ctx.org.id), eq(entries.siteId, ctx.site.id), inArray(entries.id, linked), isNull(entries.deletedAt)));
    if (found.length !== linked.length) throw validationError({ content: [NOT_THIS_SITES_ENTRY] });
  }
}

export async function assertOwnReferences(tx: TenantTx, ctx: SiteContext, document: unknown): Promise<void> {
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
