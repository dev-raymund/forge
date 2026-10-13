import "server-only";
import { record } from "@/modules/audit";
import { inTenant, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { forbidden, notFound, validationError } from "@/platform/errors";
import { refOf, summaryOf, titleForLog, type EntrySummary } from "./entry.service";
import { HOME_PATH, ParentChainError, pathUnder, reservedPathReason, wouldCreateCycle, type PageNode } from "./paths";
import { canArrangePage } from "./policies";
import { movedEvents } from "./publishing.service";
import { ancestorsOf, findEntry, lockSiteSettings, siblingsOf, setSortOrders, siteFacts, updateEntry } from "./repository";
import { moveSubtree, withPathTaken, type MovedEntry } from "./tree";

/**
 * The page tree (M5-7; plan §5 "Parent … sort order"; ADR 0016 hand-off): putting a page under another page, and
 * putting it in its place among its siblings. Pages only (CHECK `entries_only_pages_nest`); those who may edit pages.
 *
 * Both take the site's settings row lock first, as `setHomepage` does: every change to the tree of one site takes its
 * turn, so two moves at the same moment cannot make a loop that neither saw, and a move cannot cross a homepage change.
 */

const PARENT = "Choose a page of this site.";

/**
 * Puts the page under `parentId` (null: the top level). Its path becomes its slug under the parent's path, and every
 * page below follows (`moveSubtree`), in one transaction: a path another entry holds anywhere in the moved tree
 * refuses the whole move with a Conflict naming the address, and nothing has moved. The Home page keeps `/` wherever
 * it sits. Live pages whose address changed are returned as `entry.moved` events; redirects from the old addresses
 * are M8-5's.
 */
export async function movePage(ctx: SiteContext, entryId: string, parentId: string | null): Promise<{ entry: EntrySummary; changed: boolean; moved: MovedEntry[]; events: CacheEvent[] }> {
  return inTenant(ctx, async (tx) => {
    const settings = await lockSiteSettings(tx, ctx.org.id, ctx.site.id);
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    if (!settings || !site) throw notFound();
    const page = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
    if (!page) throw notFound();
    if (!canArrangePage(ctx, refOf(page))) throw page.type === "page" ? forbidden() : validationError({ parentId: ["Only pages have a parent page."] });
    if ((parentId ?? null) === page.parentId) return { entry: summaryOf(page), changed: false, moved: [], events: [] };

    let parent: { id: string; title: string; path: string } | null = null;
    if (parentId) {
      if (parentId === page.id) throw validationError({ parentId: ["A page cannot be its own parent."] });
      const target = await findEntry(tx, ctx.org.id, ctx.site.id, parentId);
      if (!target || target.type !== "page" || target.locale !== page.locale) throw validationError({ parentId: [PARENT] });
      // The chain above the new parent: no page in the trash, nothing but pages, and never the page itself (a loop).
      const above = await ancestorsOf(tx, ctx.org.id, ctx.site.id, target.id);
      const byId = new Map(above.map((row) => [row.id, row]));
      const find = (id: string): PageNode | undefined => {
        const row = byId.get(id);
        return row ? { id: row.id, slug: row.slug, parentId: row.parentId, home: row.path === HOME_PATH } : undefined;
      };
      let loops: boolean;
      try {
        loops = wouldCreateCycle(page.id, target.id, find);
      } catch (error) {
        if (error instanceof ParentChainError) throw validationError({ parentId: ["A page above that one no longer exists. Choose another parent."] });
        throw error;
      }
      if (loops) throw validationError({ parentId: ["That page is below this one. Choose a page that is not inside it."] });
      if (above.some((row) => row.deleted || row.type !== "page")) throw validationError({ parentId: ["A page above that one is in the trash. Choose another parent."] });
      parent = { id: target.id, title: target.title, path: target.path };
    }

    const path = page.path === HOME_PATH ? HOME_PATH : pathUnder(parent?.path ?? "", page.slug);
    const reserved = reservedPathReason(path, { type: "page", blogPath: site.blogPath });
    if (reserved) throw validationError({ parentId: [reserved] });

    // Last among its new siblings.
    const siblings = await siblingsOf(tx, ctx.org.id, ctx.site.id, parent?.id ?? null);
    const sortOrder = siblings.reduce((max, sibling) => Math.max(max, sibling.sortOrder + 1), 0);
    await withPathTaken(path, () => updateEntry(tx, ctx.org.id, ctx.site.id, page.id, { parentId: parent?.id ?? null, path, sortOrder, updatedBy: ctx.actor.userId }));
    const moved: MovedEntry[] = path === page.path ? [] : [{ id: page.id, type: page.type, status: page.status, title: page.title, from: page.path, to: path }];
    moved.push(...(await moveSubtree(tx, ctx, page.id, path)));

    await record(
      tx,
      {
        action: "entry.moved", resourceType: "entry", resourceId: page.id, siteId: ctx.site.id,
        metadata: { type: "page", title: titleForLog(page.title), ...(parent ? { parentTitle: titleForLog(parent.title) } : {}), from: page.path, to: path },
      },
      ctx,
    );
    return { entry: { ...summaryOf(page), parentId: parent?.id ?? null, path }, changed: true, moved, events: movedEvents(ctx.site.id, moved) };
  });
}

/**
 * Puts the page among its siblings: just before `beforeId` (a page under the same parent), or last when null. The
 * order is the tree's and the lists' (and M8-3's menus may follow it); no address changes, so nothing public is
 * flushed.
 */
export async function placePage(ctx: SiteContext, entryId: string, beforeId: string | null): Promise<{ changed: boolean; position: number; events: CacheEvent[] }> {
  return inTenant(ctx, async (tx) => {
    const settings = await lockSiteSettings(tx, ctx.org.id, ctx.site.id);
    if (!settings) throw notFound();
    const page = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
    if (!page) throw notFound();
    if (!canArrangePage(ctx, refOf(page))) throw page.type === "page" ? forbidden() : validationError({ beforeId: ["Only pages are ordered."] });
    const siblings = await siblingsOf(tx, ctx.org.id, ctx.site.id, page.parentId);
    const others = siblings.filter((sibling) => sibling.id !== page.id);
    const at = beforeId === null ? others.length : others.findIndex((sibling) => sibling.id === beforeId);
    if (at < 0) throw validationError({ beforeId: ["Choose a page at the same level."] });
    const self = siblings.find((sibling) => sibling.id === page.id)!;
    const ordered = [...others.slice(0, at), self, ...others.slice(at)];
    const position = at + 1;
    if (ordered.every((sibling, index) => sibling.id === siblings[index]!.id)) return { changed: false, position, events: [] };
    await setSortOrders(tx, ctx.org.id, ctx.site.id, ordered);
    await record(
      tx,
      { action: "entry.reordered", resourceType: "entry", resourceId: page.id, siteId: ctx.site.id, metadata: { type: "page", title: titleForLog(page.title), position, of: ordered.length } },
      ctx,
    );
    return { changed: true, position, events: [] };
  });
}
