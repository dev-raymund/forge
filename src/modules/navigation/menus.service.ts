import "server-only";
import { record } from "@/modules/audit";
import { readReading } from "@/modules/sites/shared";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import type { TenantTx } from "@/platform/db";
import { conflict, notFound, validationError } from "@/platform/errors";
import { categoriesOfSite, entryTargets, findMenu, insertMenu, menusOfSite, readingOf, termTargets, updateMenu } from "./repository";
import {
  BLOG_LABEL, checkMenuItems, countItems, flatten, isMenuLocation, itemErrorKey, MENU_LOCATIONS, readMenuItems, targetKey,
  type EditorMenu, type MenuItem, type MenuLink, type MenuLocation, type MenuTarget,
} from "./shared";

/**
 * A site's header and footer menus (M8-3; plan §7, §19 `/…/menus`; ADR 0030): `site.menus.manage`, Owners, Admins and
 * Editors.
 *
 *   getMenus   the editor's data: both menus, their versions, and what each item points at and whether the site
 *              shows it (a page in the trash, a draft, a deleted category are flagged, never dropped)
 *   saveMenu   one menu, as a whole: checked (`checkMenuItems`), its new destinations checked against the site, written
 *              at the version the editor opened (Conflict otherwise), recorded, and `site:{id}:config` flushed
 *
 * The public site resolves the same items itself (rendering's `loadMenus`): only live destinations are drawn there.
 */

export const MENU_CONFLICT = "This menu was changed somewhere else since you opened this page. Reload the page to see it, then make your change again.";

const ENTRY_WORDS: Record<string, string> = { page: "Page", post: "Post" };

export type MenusForEditor = {
  menus: Record<MenuLocation, EditorMenu>;
  /** The site's categories, to add as links. */
  categories: { id: string; name: string; slug: string }[];
  /** The blog's address on the site (`/blog`), to show where the posts' archive is. */
  blogPath: string;
};

/** The menus page's data (`site.menus.manage`). */
export async function getMenus(ctx: SiteContext): Promise<MenusForEditor> {
  requirePermission(ctx, "site.menus.manage");
  return inTenant(ctx, async (tx) => {
    const [rows, reading, categories] = await Promise.all([
      menusOfSite(tx, ctx.org.id, ctx.site.id),
      readingOf(tx, ctx.org.id, ctx.site.id),
      categoriesOfSite(tx, ctx.org.id, ctx.site.id),
    ]);
    const blogPath = `/${readReading(reading).blogPath}`;
    const read = Object.fromEntries(MENU_LOCATIONS.map((location) => {
      const row = rows.find((one) => one.location === location);
      return [location, { version: row?.version ?? 0, items: readMenuItems(row?.items) }];
    })) as Record<MenuLocation, { version: number; items: MenuItem[] }>;
    const links = MENU_LOCATIONS.flatMap((location) => flatten(read[location].items));
    const targets = await targetsOf(tx, ctx, links, blogPath);
    const menus = Object.fromEntries(MENU_LOCATIONS.map((location) => {
      const own = flatten(read[location].items).map(targetKey).filter((key): key is string => key !== null);
      return [location, { location, ...read[location], targets: Object.fromEntries(own.map((key) => [key, targets[key]!])) }];
    })) as Record<MenuLocation, EditorMenu>;
    return { menus, categories, blogPath };
  });
}

/** What the items point at, by `targetKey`: every key has an answer, `deleted` when the site no longer has it. */
async function targetsOf(tx: TenantTx, ctx: SiteContext, links: MenuLink[], blogPath: string) {
  const entryIds = [...new Set(links.flatMap((one) => (one.kind === "entry" ? [one.entryId] : [])))];
  const termIds = [...new Set(links.flatMap((one) => (one.kind === "term" ? [one.termId] : [])))];
  const [entryRows, termRows] = await Promise.all([entryTargets(tx, ctx.org.id, ctx.site.id, entryIds), termTargets(tx, ctx.org.id, ctx.site.id, termIds)]);
  const targets: Record<string, MenuTarget> = {};
  for (const id of entryIds) {
    const row = entryRows.find((one) => one.id === id);
    if (!row) {
      targets[`entry:${id}`] = { title: "A deleted page or post", detail: "Deleted", state: "deleted" };
      continue;
    }
    const live = row.status === "published" && !row.deletedAt;
    const state: MenuTarget["state"] = row.deletedAt ? "trashed" : live ? "live" : row.status === "scheduled" ? "scheduled" : "unpublished";
    const title = (live ? row.title : row.draftTitle || row.title) || "Untitled";
    targets[`entry:${id}`] = { title, detail: `${ENTRY_WORDS[row.type] ?? "Page"} · ${row.path}`, state };
  }
  for (const id of termIds) {
    const row = termRows.find((one) => one.id === id);
    targets[`term:${id}`] = row
      ? { title: row.name, detail: `${row.taxonomy === "category" ? "Category" : "Tag"} · ${blogPath}/${row.taxonomy}/${row.slug}`, state: "live" }
      : { title: "A deleted category or tag", detail: "Deleted", state: "deleted" };
  }
  if (links.some((one) => one.kind === "archive")) targets["archive:post"] = { title: BLOG_LABEL, detail: `All posts · ${blogPath}`, state: "live" };
  return targets;
}

export type MenuSave = { changed: boolean; version: number; items: MenuItem[]; events: CacheEvent[] };

/**
 * Saves one of the site's menus as a whole (M8-3): `site.menus.manage`.
 *
 * The items are checked strictly (`checkMenuItems`: kinds, addresses, two levels, 100 links). A destination new to the
 * menu must be this site's: a page or post not in the trash, a category or tag. One already in the menu is kept as it
 * is even if it is gone now (the editor flags it; the site leaves it out), so a later save never loses an item because
 * its page is unpublished for a while. Nothing an id says is trusted: it is looked up in this site.
 *
 * Written if the menu is still at the version the editor opened (0: none yet), Conflict otherwise; the same items again
 * change, record and flush nothing. A save records `menu.updated` and flushes `site:{id}:config`, under which every
 * public page reads its menus.
 */
export async function saveMenu(ctx: SiteContext, location: unknown, input: unknown, version: number): Promise<MenuSave> {
  requirePermission(ctx, "site.menus.manage");
  if (!isMenuLocation(location)) throw notFound();
  const checked = checkMenuItems(input);
  if (!checked.ok) throw validationError(checked.errors);
  const items = checked.items;
  return inTenant(ctx, async (tx) => {
    const row = await findMenu(tx, ctx.org.id, ctx.site.id, location);
    const stored = readMenuItems(row?.items);
    if (row && JSON.stringify(stored) === JSON.stringify(items)) return { changed: false, version: row.version, items, events: [] };
    if (version !== (row?.version ?? 0)) throw conflict(MENU_CONFLICT);

    const known = new Set(flatten(stored).map(targetKey));
    const fresh = flatten(items).filter((one) => !known.has(targetKey(one)));
    const freshEntries = fresh.flatMap((one) => (one.kind === "entry" ? [one] : []));
    const freshTerms = fresh.flatMap((one) => (one.kind === "term" ? [one] : []));
    const [entryRows, termRows] = await Promise.all([
      entryTargets(tx, ctx.org.id, ctx.site.id, [...new Set(freshEntries.map((one) => one.entryId))]),
      termTargets(tx, ctx.org.id, ctx.site.id, [...new Set(freshTerms.map((one) => one.termId))]),
    ]);
    const refused: Record<string, string[]> = {};
    for (const one of freshEntries) {
      const found = entryRows.find((entry) => entry.id === one.entryId);
      if (!found || found.deletedAt) refused[itemErrorKey(one.id)] = ["Choose a page or post of this site that is not in the trash."];
    }
    for (const one of freshTerms) {
      if (!termRows.some((term) => term.id === one.termId)) refused[itemErrorKey(one.id)] = ["Choose a category or tag of this site."];
    }
    if (Object.keys(refused).length) throw validationError(refused);

    const write = { organizationId: ctx.org.id, siteId: ctx.site.id, location, items, updatedBy: ctx.actor.userId };
    const saved = row ? await updateMenu(tx, { ...write, version }) : await insertMenu(tx, write);
    if (!saved) throw conflict(MENU_CONFLICT);
    await record(
      tx,
      { action: "menu.updated", resourceType: "menu", resourceId: saved.id, siteId: ctx.site.id, metadata: { name: ctx.site.name, location, items: countItems(items) } },
      ctx,
    );
    return { changed: true, version: saved.version, items, events: [{ type: "site.configChanged", siteId: ctx.site.id }] };
  });
}
