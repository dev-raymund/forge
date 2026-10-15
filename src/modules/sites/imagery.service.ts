import "server-only";
import { z } from "zod";
import { record } from "@/modules/audit";
import { imagePreviews, siteImageRefusal, type ImagePreview } from "@/modules/media";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { notFound, validationError } from "@/platform/errors";
import { findSiteRow, readSiteImageIds, updateSiteImage, type SiteImageRole } from "./repository";

/**
 * The site's logo and favicon (M6-4, plan §8): images of the site's media library, chosen with the picker. Their
 * variants are made when the image is uploaded (a logo fitted in 640 × 240, favicons of 32 and 180 px, ADR 0023);
 * setting one only points at the image.
 *
 * Who may: `site.settings.manage` (Owner, Admin). Which image: one the server finds usable for that role in this site
 * (ready, not in the trash, an image, with the role's variants). The browser's id is only a request.
 */

export const SITE_IMAGE_ROLES = ["logo", "favicon"] as const;
export const isSiteImageRole = (value: unknown): value is SiteImageRole => typeof value === "string" && (SITE_IMAGE_ROLES as readonly string[]).includes(value);

/** What the settings page shows: each role's image id and, while it is usable, its preview. */
export type SiteImagesView = Record<SiteImageRole, { mediaId: string | null; preview: ImagePreview | null }>;

export async function getSiteImages(ctx: SiteContext): Promise<SiteImagesView> {
  requirePermission(ctx, "site.settings.manage");
  return inTenant(ctx, async (tx) => {
    const ids = await readSiteImageIds(tx, ctx.org.id, ctx.site.id);
    if (!ids) throw notFound();
    const previews = await imagePreviews(tx, ctx.org.id, ctx.site.id, [ids.logo, ids.favicon].filter((id): id is string => !!id));
    return {
      logo: { mediaId: ids.logo, preview: ids.logo ? (previews[ids.logo] ?? null) : null },
      favicon: { mediaId: ids.favicon, preview: ids.favicon ? (previews[ids.favicon] ?? null) : null },
    };
  });
}

/**
 * Sets (an id) or removes (null) the logo or the favicon. The same image again changes nothing: nothing is written,
 * recorded or flushed. A change is recorded as a settings change ("images" group) and flushes the site's settings
 * cache, which the public site's logo and favicon are read with.
 */
export async function setSiteImage(ctx: SiteContext, role: SiteImageRole, mediaId: string | null): Promise<{ changed: boolean; events: CacheEvent[] }> {
  requirePermission(ctx, "site.settings.manage");
  if (mediaId !== null && !z.uuid().safeParse(mediaId).success) throw validationError({ [role]: ["Choose an image of this site's media library."] });

  return inTenant(ctx, async (tx) => {
    const site = await findSiteRow(tx, ctx.org.id, ctx.site.id);
    const ids = site ? await readSiteImageIds(tx, ctx.org.id, site.id, true) : null;
    if (!site || !ids) throw notFound();
    if (ids[role] === mediaId) return { changed: false, events: [] };
    if (mediaId !== null) {
      const refusal = await siteImageRefusal(tx, ctx.org.id, site.id, mediaId, role);
      if (refusal) throw validationError({ [role]: [refusal] });
    }
    await updateSiteImage(tx, ctx.org.id, site.id, role, mediaId, ctx.actor.userId);
    await record(
      tx,
      { action: "site.settings_changed", resourceType: "site", resourceId: site.id, siteId: site.id, metadata: { name: site.name, group: "images", fields: [role] } },
      ctx,
    );
    return { changed: true, events: [{ type: "site.configChanged", siteId: site.id }] };
  });
}
