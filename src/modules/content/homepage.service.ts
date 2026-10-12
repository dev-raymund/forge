import "server-only";
import { record } from "@/modules/audit";
import { inTenant, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { forbidden, notFound, validationError } from "@/platform/errors";
import { titleForLog } from "./entry.service";
import { HOME_PATH } from "./paths";
import { canSetHomepage } from "./policies";
import { movedEvents } from "./publishing.service";
import { entryAtPath, findEntry, lockSiteSettings, renameDraftSlug, setHomepageEntry, siteFacts, updateEntry } from "./repository";
import { moveSubtree, withPathTaken, type MovedEntry } from "./tree";
import { insertWithUniqueSlug } from "./unique-slug";

/**
 * The site's home page (M5-3; plan §3 "homepage", §5 "Home = `/`"; ADR 0016).
 * The Home page is the page stored at `/`, and `site_settings.homepage_entry_id`
 * names it. Making another page the Home page, in one transaction:
 *
 *   1. lock the site's settings row: two changes of one site's homepage take turns
 *   2. the current Home leaves `/` for an ordinary path where it sits in the tree
 *      (its slug, or the first free suffix: `home`, `home-2`, …), and the pages
 *      below it follow (they were at the top level; now they are under it)
 *   3. the new Home takes `/`, and the pages below it follow (they come to the top level)
 *   4. `homepage_entry_id` names it; `site.homepage_changed` is recorded
 *
 * Nothing is renamed but the old Home's slug if its own was taken, and the
 * tree is unchanged: every page keeps its parent. If a page's new path is
 * another page's, the whole change is refused with a Conflict naming the
 * address, and nothing moves. At no moment of the committed history are there
 * two pages at `/`, or none while the change is under way and visible.
 *
 * Who: `site.settings.manage` (Owner, Admin): the homepage is a website setting.
 */
export async function setHomepage(ctx: SiteContext, entryId: string): Promise<{ changed: boolean; moved: MovedEntry[]; events: CacheEvent[] }> {
  if (!canSetHomepage(ctx)) throw forbidden();
  return inTenant(ctx, async (tx) => {
    const settings = await lockSiteSettings(tx, ctx.org.id, ctx.site.id);
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    if (!settings || !site) throw notFound();
    const next = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
    if (!next) throw notFound();
    if (next.type !== "page") throw validationError({ entryId: ["Only a page can be the home page."] });

    if (next.path === HOME_PATH) {
      // Already the Home page. A settings row that lost track of it is put right, and nothing else changes.
      if (settings.homepageEntryId !== next.id) await setHomepageEntry(tx, ctx.org.id, ctx.site.id, next.id);
      return { changed: false, moved: [], events: settings.homepageEntryId !== next.id ? [{ type: "site.configChanged", siteId: ctx.site.id }] : [] };
    }

    const moved: MovedEntry[] = [];
    const current = await entryAtPath(tx, ctx.org.id, ctx.site.id, next.locale, HOME_PATH);
    if (current) {
      // 2. Off `/`, to where it sits in the tree. Its slug is generated, not typed: a suffix is fine.
      const parent = current.parentId ? await findEntry(tx, ctx.org.id, ctx.site.id, current.parentId) : null;
      const { slug, path } = await insertWithUniqueSlug(
        tx,
        ctx,
        { type: "page", locale: current.locale, dir: parent?.path ?? "", base: current.slug, blogPath: site.blogPath },
        (savepoint, slug, path) => updateEntry(savepoint, ctx.org.id, ctx.site.id, current.id, { slug, path, updatedBy: ctx.actor.userId }),
      );
      if (slug !== current.slug) await renameDraftSlug(tx, ctx.org.id, ctx.site.id, current.id, current.slug, slug);
      moved.push({ id: current.id, type: current.type, status: current.status, title: current.title, from: HOME_PATH, to: path });
      moved.push(...(await moveSubtree(tx, ctx, current.id, path)));
    }

    // 3. Onto `/` (its path may just have changed, if it was below the old Home).
    await withPathTaken(HOME_PATH, () => updateEntry(tx, ctx.org.id, ctx.site.id, next.id, { path: HOME_PATH, updatedBy: ctx.actor.userId }));
    moved.push({ id: next.id, type: next.type, status: next.status, title: next.title, from: next.path, to: HOME_PATH });
    moved.push(...(await moveSubtree(tx, ctx, next.id, HOME_PATH)));

    // 4. The setting, and the record.
    await setHomepageEntry(tx, ctx.org.id, ctx.site.id, next.id);
    await record(
      tx,
      {
        action: "site.homepage_changed", resourceType: "site", resourceId: ctx.site.id, siteId: ctx.site.id,
        metadata: { name: site.name, title: titleForLog(next.title), ...(current ? { previousTitle: titleForLog(current.title) } : {}) },
      },
      ctx,
    );
    // A page that moved twice (below the old Home, then with the new one) is told once: where it was, and where it ended.
    const once = new Map<string, MovedEntry>();
    for (const page of moved) once.set(page.id, once.has(page.id) ? { ...page, from: once.get(page.id)!.from } : page);
    const net = [...once.values()].filter((page) => page.from !== page.to);
    return { changed: true, moved: net, events: [{ type: "site.configChanged", siteId: ctx.site.id }, ...movedEvents(ctx.site.id, net)] };
  });
}
