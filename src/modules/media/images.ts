import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { mediaPublicBaseUrl } from "@/platform/config/env";
import type { TenantTx } from "@/platform/db";
import { isWidthVariant } from "./processing";
import { mediaAssets, type MediaVariant } from "./schema";

/**
 * Images as the rest of Forge uses them (M6-4): content, the site's logo and favicon, the editor's previews and the
 * public renderer. One rule for "usable": an image of this site, uploaded and checked (`ready`), not in the trash.
 * Every query names the organization and the site (RLS keeps organizations apart, not two sites of one); the
 * caller's transaction is the tenant's. Only variants are ever pointed at: an image's original is never served.
 */

const urlOf = (key: string) => `${mediaPublicBaseUrl()}/${key}`;

type ImageRow = { id: string; altText: string; width: number | null; height: number | null; variants: MediaVariant[]; originalFilename: string; title: string };

async function usableRows(tx: TenantTx, organizationId: string, siteId: string, ids: readonly string[]): Promise<ImageRow[]> {
  const unique = [...new Set(ids)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!unique.length) return [];
  return tx
    .select({
      id: mediaAssets.id, altText: mediaAssets.altText, width: mediaAssets.width, height: mediaAssets.height, variants: mediaAssets.variants,
      originalFilename: mediaAssets.originalFilename, title: mediaAssets.title,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.organizationId, organizationId),
        eq(mediaAssets.siteId, siteId),
        inArray(mediaAssets.id, unique),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
        eq(mediaAssets.kind, "image"),
      ),
    );
}

/** Which of these ids are usable images of this site now. A PDF, a pending or refused upload, a trashed one, another site's: not. */
export async function usableImageIds(tx: TenantTx, organizationId: string, siteId: string, ids: readonly string[]): Promise<Set<string>> {
  return new Set((await usableRows(tx, organizationId, siteId, ids)).map((row) => row.id));
}

/** What the editor shows for an image it holds: a thumbnail (the square variant) and a name. */
export type ImagePreview = { id: string; name: string; altText: string; thumbUrl: string | null; width: number | null; height: number | null };

export async function imagePreviews(tx: TenantTx, organizationId: string, siteId: string, ids: readonly string[]): Promise<Record<string, ImagePreview>> {
  const rows = await usableRows(tx, organizationId, siteId, ids);
  return Object.fromEntries(
    rows.map((row) => {
      const thumb = row.variants.find((v) => v.key === "thumb");
      return [row.id, { id: row.id, name: row.title || row.originalFilename, altText: row.altText, thumbUrl: thumb ? urlOf(thumb.storageKey) : null, width: row.width, height: row.height }];
    }),
  );
}

/** An image as a public page draws it (`<ResponsiveImage>`): its own alt text, intrinsic size, and the widths it has. */
export type PublicImage = { alt: string; width: number; height: number; sources: { url: string; width: number; height: number }[] };
/** The site's logo (one fitted variant) and favicons, as the theme and the page's head use them. */
export type SiteImagery = { logo: { url: string; width: number; height: number } | null; favicon: { url32: string; url180: string } | null };

function publicImageOf(row: ImageRow): PublicImage | null {
  const sources = row.variants
    .filter((variant) => isWidthVariant(variant.key) && variant.width > 0 && variant.height > 0)
    .map((variant) => ({ url: urlOf(variant.storageKey), width: variant.width, height: variant.height }))
    .sort((a, b) => a.width - b.width);
  if (!sources.length || !row.width || !row.height) return null;
  return { alt: row.altText, width: row.width, height: row.height, sources };
}

/** The usable images among these ids, as public pages draw them. An id that is not one simply has no entry: nothing is drawn. */
export async function publicImages(tx: TenantTx, organizationId: string, siteId: string, ids: readonly string[]): Promise<Record<string, PublicImage>> {
  const images: Record<string, PublicImage> = {};
  for (const row of await usableRows(tx, organizationId, siteId, ids)) {
    const image = publicImageOf(row);
    if (image) images[row.id] = image;
  }
  return images;
}

/** The site's logo and favicon from their media ids: only if each is still usable and has its variants (made at upload). */
export async function siteImagery(tx: TenantTx, organizationId: string, siteId: string, ids: { logo: string | null; favicon: string | null }): Promise<SiteImagery> {
  const rows = await usableRows(tx, organizationId, siteId, [ids.logo, ids.favicon].filter((id): id is string => !!id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const variant = (id: string | null, key: string) => (id ? byId.get(id)?.variants.find((v) => v.key === key) : undefined);
  const logo = variant(ids.logo, "logo");
  const [fav32, fav180] = [variant(ids.favicon, "fav32"), variant(ids.favicon, "fav180")];
  return {
    logo: logo ? { url: urlOf(logo.storageKey), width: logo.width, height: logo.height } : null,
    favicon: fav32 && fav180 ? { url32: urlOf(fav32.storageKey), url180: urlOf(fav180.storageKey) } : null,
  };
}

/**
 * Why this media id cannot be the site's logo or favicon, or null when it can: a usable image of the site that has
 * the variants that role needs (an image uploaded before M6-4 does not, and is uploaded again).
 */
export async function siteImageRefusal(tx: TenantTx, organizationId: string, siteId: string, mediaId: string, role: "logo" | "favicon"): Promise<string | null> {
  const [row] = await usableRows(tx, organizationId, siteId, [mediaId]);
  if (!row) return "Choose an image of this site's media library.";
  const needed = role === "logo" ? ["logo"] : ["fav32", "fav180"];
  if (!needed.every((key) => row.variants.some((v) => v.key === key))) return `This image was uploaded before ${role === "logo" ? "logos" : "favicons"} could be made from it. Upload it again, then choose the new copy.`;
  return null;
}
