import { connection } from "next/server";
import { indexableNotice, loadPublicSite, loadSitemapRows, resolveSite, siteBaseUrl, sitemapUrlsOf } from "@/modules/rendering";
import { sitemapXml } from "@/modules/seo/shared";
import { decodeSiteLocator } from "@/platform/routing/hosts";

/**
 * A site's sitemap (M8-4; plan §10, §19): `/s/{address}/sitemap.xml`, reached through the proxy's rewrite like every
 * page of the site. Only a live site that allows indexing has one: a site that is coming soon, suspended, deleted,
 * unknown, or that discourages indexing answers 404, so no list of its content leaks before it is public. Its
 * addresses are its live, indexable entries and its non-empty archives (`sitemapUrlsOf`), under the site's base.
 *
 * Answered per request (never a prerendered response): what it reads is cached under the site's tags, which every
 * change it depends on flushes (publishing, the trash, a term, the site's status and SEO settings).
 */
export async function GET(_request: Request, { params }: RouteContext<"/render/[site]/sitemap.xml">) {
  await connection();
  const { site: segment } = await params;
  const locator = decodeSiteLocator(segment);
  const resolved = locator ? await resolveSite(locator) : null;
  const site = resolved ? await loadPublicSite(resolved.orgId, resolved.siteId) : null;
  if (!locator || !site || site.status !== "live" || site.seo.discourageIndexing) return indexableNotice();
  const rows = await loadSitemapRows(site.orgId, site.id, site.language);
  return new Response(sitemapXml(sitemapUrlsOf(rows, siteBaseUrl(locator), site.reading.blogPath)), {
    headers: { "content-type": "application/xml; charset=utf-8", "x-robots-tag": "noindex" },
  });
}
