import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { referencesOf } from "@/modules/content/shared";
import { encodeSitePath, isSitePath, REDIRECTS_MAX, responseStatusOf, type RedirectStatus } from "@/modules/seo/shared";
import { CMS_CACHE_PROFILE, tags } from "@/platform/cache";
import { withTenant } from "@/platform/db";
import { redirects } from "@/platform/db/schema";
import { siteBasePath, type SiteLocator } from "@/platform/routing/hosts";
import { livePaths, loadEntry, resolveRoute } from "./content";
import type { PublicPage } from "./public-page";
import type { PublicSite } from "./queries";

/**
 * Redirects on the public site (M8-5; plan §10; cms-architecture §12.7 "route resolution order": 1. exact redirect;
 * ADR 0032). A site's active redirects are one cached map (`site:{id}:config`, which every redirect write flushes),
 * matched in memory before the path is resolved: no database round trip per request.
 *
 * A redirect is followed only to a destination the site serves now (its route resolves, cached under `routes`), so a
 * redirect never leads to a page that is not published; otherwise its source answers 404 like any unknown address.
 * An address elsewhere is sent as it is (checked when it was written: http(s), another host).
 */

export type RedirectMap = Record<string, { to: string; status: RedirectStatus }>;

/** The site's active redirects, source → destination and status. Sources are paths (`/…`), so no key is an object's own. */
export async function loadRedirects(orgId: string, siteId: string): Promise<RedirectMap> {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  cacheTag(tags.site(siteId), tags.config(siteId));
  const rows = await withTenant({ orgId }, (tx) =>
    tx
      .select({ source: redirects.sourcePath, destination: redirects.destination, status: redirects.statusCode })
      .from(redirects)
      .where(and(eq(redirects.organizationId, orgId), eq(redirects.siteId, siteId), eq(redirects.isActive, true)))
      .orderBy(desc(redirects.updatedAt))
      .limit(REDIRECTS_MAX),
  );
  const map: RedirectMap = {};
  for (const row of rows) if (row.source.startsWith("/") && !Object.hasOwn(map, row.source)) map[row.source] = { to: row.destination, status: row.status as RedirectStatus };
  return map;
}

export type PublicRedirect = { location: string; status: 307 | 308 };

/**
 * Where a live site sends a visitor of these segments (as Next decoded them), or null. A segment holding a `/` (an
 * encoded `%2F`) is no path of the site, as for the routes. The location is the site's public address
 * (`/s/{address}/…` in V1, from the locator, never a request header), or the address elsewhere.
 */
export async function publicRedirectFor(site: PublicSite, locator: SiteLocator, segments: readonly string[]): Promise<PublicRedirect | null> {
  if (segments.some((segment) => segment.includes("/"))) return null;
  const path = segments.length ? `/${segments.join("/")}` : "/";
  const map = await loadRedirects(site.orgId, site.id);
  if (!Object.hasOwn(map, path)) return null;
  const { to, status } = map[path]!;
  if (!isSitePath(to)) return { location: to, status: responseStatusOf(status) };
  const target = to === "/" ? [] : to.slice(1).split("/");
  if (!(await resolveRoute(site.orgId, site.id, site.language, site.reading.blogPath, target))) return null;
  const base = siteBasePath(locator);
  return { location: to === "/" ? base : `${base}${encodeSitePath(to)}`, status: responseStatusOf(status) };
}

/**
 * The site's own not-found page (M8-5, plan §10 "custom 404 page setting"), as a public page: while it is a published
 * page of the site, read from its published revision like any other; otherwise null (the theme's not-found page).
 */
export async function notFoundPageFor(site: PublicSite): Promise<PublicPage | null> {
  if (!site.notFoundEntryId) return null;
  const entry = await loadEntry(site.orgId, site.id, site.notFoundEntryId);
  if (!entry || entry.type !== "page" || entry.path === "/") return null;
  const linked = [...referencesOf(entry.content).entryIds].sort();
  return { kind: "entry", entry, links: await livePaths(site.orgId, site.id, site.language, linked) };
}
