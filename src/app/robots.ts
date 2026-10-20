import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { indexableSiteAddresses, searchIndexingAllowed } from "@/modules/rendering";
import { robotsRules } from "@/modules/seo/shared";
import { env } from "@/platform/config/env";

/**
 * The app host's `/robots.txt` (M8-4; plan §10, §19; path mode, V1): sites live under `/s/`, which crawlers may read;
 * the API and previews are disallowed; every live site that allows indexing lists its sitemap. A deployment that is
 * not production (`SEARCH_INDEXING`) disallows everything. Host mode (a robots.txt per site's host) is post-V1.
 *
 * Never prerendered: the build has no database and is not the deployment it serves (`SEARCH_INDEXING` is read when it
 * is requested). The list itself is cached (`indexableSiteAddresses`) until a site's status, address or SEO changes.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  const allowed = searchIndexingAllowed();
  const origin = env("core").APP_ORIGIN;
  return robotsRules({ indexingAllowed: allowed, origin, addresses: allowed ? await indexableSiteAddresses(new URL(origin).hostname) : [] });
}
