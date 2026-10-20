import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { sitePath } from "@/blocks/render-context";
import { BLOG_LABEL, flatten, readMenuItems, type MenuItem, type MenuLink } from "@/modules/navigation/shared";
import { CMS_CACHE_PROFILE, tags } from "@/platform/cache";
import { withTenant } from "@/platform/db";
import { entries, menus, terms } from "@/platform/db/schema";
import { siteBasePath, type SiteLocator } from "@/platform/routing/hosts";
import type { NavItem } from "@/themes/types";
import type { PublicSite } from "./queries";

/**
 * A site's menus as its visitors see them (M8-3; ADR 0030). The stored items name their destinations by id; here each
 * is looked up in the site, as it is now:
 *
 *   entry     drawn only while it is live (published, not in the trash, this site's, in the site's language), at its
 *             live path, labelled with its published title unless the item has its own label. A draft, a scheduled
 *             post, a page in the trash, a deleted one, another site's: left out, and its title never read
 *   term      drawn while the category or tag exists, at its archive under the blog's path
 *   archive   the blog, at the blog's path
 *   url       a path on the site, or an address (checked when saved: `safeHref`)
 *
 * An item left out takes nothing with it: the links under it take its place. Nothing is ever written back: when a page
 * is published again, or restored and published, its link returns as it was.
 *
 * Cached per site under its config tag (menus, the blog's path: `site.configChanged`) and its routes tag (what is live
 * and where: publishing, unpublishing, the trash, a move, a term's change all flush it at once, D-27).
 */

export type PublicMenuLink = { label: string; path?: string; url?: string; newTab: boolean; children: PublicMenuLink[] };
export type PublicMenus = { header: PublicMenuLink[]; footer: PublicMenuLink[] };

export async function loadMenus(orgId: string, siteId: string, locale: string, blogPath: string): Promise<PublicMenus> {
  "use cache";
  cacheLife(CMS_CACHE_PROFILE);
  cacheTag(tags.site(siteId), tags.config(siteId), tags.routes(siteId));
  return withTenant({ orgId }, async (tx) => {
    const rows = await tx.select({ location: menus.location, items: menus.items }).from(menus).where(and(eq(menus.organizationId, orgId), eq(menus.siteId, siteId)));
    const header = readMenuItems(rows.find((row) => row.location === "header")?.items);
    const footer = readMenuItems(rows.find((row) => row.location === "footer")?.items);
    const links = [...flatten(header), ...flatten(footer)];
    const entryIds = [...new Set(links.flatMap((one) => (one.kind === "entry" ? [one.entryId] : [])))];
    const termIds = [...new Set(links.flatMap((one) => (one.kind === "term" ? [one.termId] : [])))];
    const [live, found] = await Promise.all([
      entryIds.length
        ? tx
            .select({ id: entries.id, title: entries.title, path: entries.path })
            .from(entries)
            .where(
              and(
                eq(entries.organizationId, orgId), eq(entries.siteId, siteId), eq(entries.locale, locale), eq(entries.status, "published"), isNull(entries.deletedAt),
                inArray(entries.id, entryIds),
              ),
            )
        : [],
      termIds.length
        ? tx
            .select({ id: terms.id, taxonomy: terms.taxonomy, name: terms.name, slug: terms.slug })
            .from(terms)
            .where(and(eq(terms.organizationId, orgId), eq(terms.siteId, siteId), inArray(terms.id, termIds)))
        : [],
    ]);
    const blog = `/${blogPath}`;
    const one = (link: MenuLink): Omit<PublicMenuLink, "children"> | null => {
      switch (link.kind) {
        case "entry": {
          const entry = live.find((row) => row.id === link.entryId);
          return entry ? { label: link.label || entry.title || "Untitled", path: entry.path, newTab: link.newTab } : null;
        }
        case "term": {
          const term = found.find((row) => row.id === link.termId);
          return term ? { label: link.label || term.name, path: `${blog}/${term.taxonomy}/${term.slug}`, newTab: link.newTab } : null;
        }
        case "archive":
          return { label: link.label || BLOG_LABEL, path: blog, newTab: link.newTab };
        case "url":
          return link.url.startsWith("/") ? { label: link.label, path: link.url, newTab: link.newTab } : { label: link.label, url: link.url, newTab: link.newTab };
      }
    };
    const tree = (items: MenuItem[]): PublicMenuLink[] =>
      items.flatMap((item) => {
        const children = (item.children ?? []).flatMap((child) => {
          const resolved = one(child);
          return resolved ? [{ ...resolved, children: [] }] : [];
        });
        const own = one(item);
        return own ? [{ ...own, children }] : children;
      });
    return { header: tree(header), footer: tree(footer) };
  });
}

/** The menus as the theme draws them: every path under the site's base (`/s/{address}` in V1). */
export function menuNavItems(menus: PublicMenus, locator: SiteLocator): { header: NavItem[]; footer: NavItem[] } {
  const base = siteBasePath(locator);
  const nav = (links: PublicMenuLink[]): NavItem[] =>
    links.map((link) => ({
      label: link.label,
      href: link.path !== undefined ? sitePath(base, link.path) : link.url!,
      ...(link.newTab ? { newTab: true } : {}),
      ...(link.children.length ? { children: nav(link.children) } : {}),
    }));
  return { header: nav(menus.header), footer: nav(menus.footer) };
}

/** A request's site's menus, ready for its theme. */
export async function publicMenusFor(site: PublicSite, locator: SiteLocator): Promise<{ header: NavItem[]; footer: NavItem[] }> {
  return menuNavItems(await loadMenus(site.orgId, site.id, site.language, site.reading.blogPath), locator);
}
