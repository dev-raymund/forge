import "server-only";
import { record } from "@/modules/audit";
import { NO_REDIRECT_CHANGES, redirectEvents, redirectUnpublished, type RedirectChanges } from "@/modules/seo";
import { can, inTenant, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import type { TenantTx } from "@/platform/db";
import { conflict, forbidden, notFound } from "@/platform/errors";
import { refOf, summaryOf, titleForLog, type EntrySummary } from "./entry.service";
import { ENTRY_TRASH_DAYS, stateOf, transition } from "./lifecycle";
import { HOME_PATH, pathUnder, reservedPathReason } from "./paths";
import { canPublishEntry, canPurgeEntry, canSeeEntry, canTrashEntry } from "./policies";
import {
  deleteTrashed, descendantsOf, everythingBelow, findEntry, findTrashedEntry, holdersOf, lockEntries, lockSiteSettings, moveToTrash, replaceEntryTerms, restoreRow,
  siteFacts, trashedWith, updateEntry, type EntryRow,
} from "./repository";
import { withPathTaken } from "./tree";

/**
 * An entry's lifecycle after publishing (M7-1; plan §9; ./lifecycle.ts for the transitions): unpublish, the trash,
 * restore, and deleting for good. Each is one transaction with its record; a refusal writes nothing.
 *
 *   unpublish   published → draft. Off the site at once (its path, the lists, the archives, links to it); its
 *               revisions, its date and its draft are kept, so publishing again brings it back as it was. Its address
 *               then answers "not found", unless the person sends its visitors elsewhere ("redirect this address
 *               to…", plan §9; M8-5): a redirect by hand, in the same transaction, for those who manage redirects.
 *   trash       a draft (never a published or scheduled entry: unpublish first) goes to the trash, its address free.
 *               A page goes with every page below it, all at one moment, or not at all: refused if any of them is
 *               published or scheduled, or is the Home page (make another page the Home page first).
 *   restore     out of the trash as a draft (never republished), with the pages trashed with it, at the addresses the
 *               tree now gives them: refused, naming the address, if any is taken; refused if the page above it is
 *               in the trash or gone, or after 30 days in the trash (`trash.purge`'s by then).
 *   purge       deleted for good, with the pages below it (all in the trash), its draft, revisions and term links.
 *
 * The tree's changes take the site's settings row lock first, as moving pages and setting the homepage do, so a
 * trash, a restore, a purge, a move and a homepage change of one site take turns.
 */

const PAGE_BELOW = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;

const visible = (ctx: SiteContext, entry: EntryRow) => canSeeEntry(ctx, refOf(entry));

export type Unpublished = { entry: EntrySummary; changed: boolean; redirects: RedirectChanges; events: CacheEvent[] };

/**
 * Takes a published entry off the site. An entry that is already a draft is left as it is (a repeated request).
 * `redirectTo` (a path the site serves, or an http(s) address elsewhere) sends visitors of its address there; a
 * destination the rules refuse refuses the unpublish, keyed `redirectTo`.
 */
export async function unpublishEntry(ctx: SiteContext, entryId: string, options: { redirectTo?: string } = {}): Promise<Unpublished> {
  const redirectTo = options.redirectTo?.trim() || null;
  if (redirectTo && !can(ctx, "site.seo.manage")) throw forbidden("Only those who manage the site's redirects can send its visitors elsewhere.");
  return inTenant(ctx, async (tx) => {
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
    if (!entry || !visible(ctx, entry)) throw notFound();
    if (!canPublishEntry(ctx, refOf(entry))) throw forbidden();
    if (entry.status === "draft") return { entry: summaryOf(entry), changed: false, redirects: NO_REDIRECT_CHANGES, events: [] };
    const step = transition(stateOf(entry), "unpublish");
    if (!step.ok) throw conflict(step.reason);

    // The published projection's pointer and its term links go; the revisions, the dates and the draft stay.
    await updateEntry(tx, ctx.org.id, ctx.site.id, entry.id, { status: "draft", publishedRevisionId: null, scheduledAt: null, updatedBy: ctx.actor.userId });
    await replaceEntryTerms(tx, ctx.org.id, ctx.site.id, entry.id, []);
    await record(
      tx,
      { action: "entry.unpublished", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id, metadata: { type: entry.type, title: titleForLog(entry.title), path: entry.path } },
      ctx,
    );
    const redirects = redirectTo ? await redirectUnpublished(tx, ctx, entry.path, redirectTo) : NO_REDIRECT_CHANGES;
    return {
      entry: { ...summaryOf(entry), status: "draft" },
      changed: true,
      redirects,
      events: [{ type: "entry.unpublished", siteId: ctx.site.id, entryId: entry.id, contentType: entry.type }, ...redirectEvents(ctx.site.id, redirects)],
    };
  });
}

/**
 * Locks every page below `root` that is not in the trash, until no new one appears: a page created under one of them
 * meanwhile (creating takes a share lock on its parent) is found and locked too, so none can be added once this returns.
 */
async function lockSubtree(tx: TenantTx, ctx: SiteContext, rootId: string): Promise<EntryRow[]> {
  const locked = new Map<string, EntryRow>();
  for (;;) {
    const below = await descendantsOf(tx, ctx.org.id, ctx.site.id, rootId);
    const fresh = below.filter((row) => !locked.has(row.id)).map((row) => row.id);
    if (!fresh.length) break;
    for (const row of await lockEntries(tx, ctx.org.id, ctx.site.id, fresh)) if (!row.deletedAt) locked.set(row.id, row);
  }
  return [...locked.values()];
}

export type Trashed = { entry: EntrySummary; below: number; events: CacheEvent[] };

/** Moves a draft, and the pages below it, to the trash. */
export async function trashEntry(ctx: SiteContext, entryId: string): Promise<Trashed> {
  return inTenant(ctx, async (tx) => {
    const settings = await lockSiteSettings(tx, ctx.org.id, ctx.site.id);
    if (!settings) throw notFound();
    const entry = await findEntry(tx, ctx.org.id, ctx.site.id, entryId, { lock: true });
    if (!entry || !visible(ctx, entry)) throw notFound();
    if (!canTrashEntry(ctx, refOf(entry))) throw forbidden();
    const step = transition(stateOf(entry), "trash");
    if (!step.ok) throw conflict(step.reason);
    if (entry.path === HOME_PATH || settings.homepageEntryId === entry.id) {
      throw conflict("This is the home page. Make another page the home page first (open it and choose “Set as home page”), then move this one to the trash.");
    }

    const below = entry.type === "page" ? await lockSubtree(tx, ctx, entry.id) : [];
    const live = below.filter((page) => page.status !== "draft");
    if (live.length) {
      const names = live.slice(0, 3).map((page) => `“${titleForLog(page.title)}”`).join(", ");
      throw conflict(`${PAGE_BELOW(live.length)} below it ${live.length === 1 ? "is" : "are"} published or scheduled (${names}${live.length > 3 ? ", …" : ""}). Unpublish ${live.length === 1 ? "it" : "them"} first: a page goes to the trash with every page below it.`);
    }
    if (below.some((page) => page.path === HOME_PATH || page.id === settings.homepageEntryId)) {
      throw conflict("The home page is below it. Make another page the home page first: a page goes to the trash with every page below it.");
    }

    await moveToTrash(tx, ctx.org.id, ctx.site.id, [entry.id, ...below.map((page) => page.id)], ctx.actor.userId);
    await record(
      tx,
      {
        action: "entry.trashed", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: { type: entry.type, title: titleForLog(entry.title), path: entry.path, below: below.length },
      },
      ctx,
    );
    // Only drafts went: nothing public changes, so nothing is flushed. Their addresses are free from now on.
    return { entry: summaryOf(entry), below: below.length, events: [] };
  });
}

export type Restored = { entry: EntrySummary; below: number; events: CacheEvent[] };

/**
 * Restores an entry from the trash as a draft, with the pages trashed with it. Every address is checked before anything
 * is written: a page's is its slug under its parent's address as it is now (the parent may have moved meanwhile, and
 * the pages below follow it as live ones would have); a post's is where it was. One taken, or reserved, refuses the
 * whole restore with a Conflict naming it.
 */
export async function restoreEntry(ctx: SiteContext, entryId: string): Promise<Restored> {
  return inTenant(ctx, async (tx) => {
    const settings = await lockSiteSettings(tx, ctx.org.id, ctx.site.id);
    const site = await siteFacts(tx, ctx.org.id, ctx.site.id);
    if (!settings || !site) throw notFound();
    const entry = await findTrashedEntry(tx, ctx.org.id, ctx.site.id, entryId, ENTRY_TRASH_DAYS);
    if (!entry || !visible(ctx, entry)) throw notFound();
    if (!canTrashEntry(ctx, refOf(entry))) throw forbidden();
    const step = transition(stateOf(entry), "restore");
    if (!step.ok) throw conflict(step.reason);
    if (entry.expired) throw conflict(`It has been in the trash for more than ${ENTRY_TRASH_DAYS} days and is being deleted for good.`);

    const group = await trashedWith(tx, ctx.org.id, ctx.site.id, entry.id);
    await lockEntries(tx, ctx.org.id, ctx.site.id, group.map((row) => row.id));

    // Where each goes: the root under its parent as it is now; the others under theirs, computed shallowest first.
    let rootPath = entry.path;
    if (entry.type === "page") {
      if (entry.parentId) {
        const parent = await findEntry(tx, ctx.org.id, ctx.site.id, entry.parentId, { share: true });
        if (!parent) throw conflict("The page above it is in the trash. Restore that page first.");
        rootPath = pathUnder(parent.path, entry.slug);
      } else if (entry.path !== pathUnder("", entry.slug)) {
        // Its parent was deleted for good (the key set `parent_id` to null): its old place no longer exists.
        throw conflict(`The page it was under has been deleted for good, so it cannot go back to ${entry.path}.`);
      }
    }
    const pathOf = new Map<string, string>([[entry.id, rootPath]]);
    for (const row of group.slice(1)) pathOf.set(row.id, pathUnder(pathOf.get(row.parentId!)!, row.slug));

    for (const row of group) {
      const reserved = row.type === "page" ? reservedPathReason(pathOf.get(row.id)!, { type: "page", blogPath: site.blogPath }) : null;
      if (reserved) throw conflict(`It cannot go back to ${pathOf.get(row.id)}: ${reserved}`);
    }
    const taken = await holdersOf(tx, ctx.org.id, ctx.site.id, entry.locale, [...pathOf.values()]);
    if (taken.length) {
      const first = taken.sort((a, b) => a.path.localeCompare(b.path))[0]!;
      throw conflict(
        `The address ${first.path} is now used by “${titleForLog(first.title)}”. Give that one another address, then restore this ${entry.type === "page" ? "page" : "post"}. Nothing was restored.`,
      );
    }

    // A path taken in the meantime by an entry created outside the tree's lock still fails here, as a Conflict naming it.
    for (const row of group) {
      const path = pathOf.get(row.id)!;
      await withPathTaken(path, () => restoreRow(tx, ctx.org.id, ctx.site.id, row.id, path, ctx.actor.userId));
    }
    await record(
      tx,
      {
        action: "entry.restored", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: { type: entry.type, title: titleForLog(entry.title), path: rootPath, below: group.length - 1 },
      },
      ctx,
    );
    // Drafts come back: nothing public changes.
    return { entry: { ...summaryOf(entry), status: "draft", path: rootPath }, below: group.length - 1, events: [] };
  });
}

export type Purged = { below: number; events: CacheEvent[] };

/**
 * Deletes an entry in the trash for good, now, with every page below it (all in the trash: a trashed page never has
 * live pages below it). Its draft, revisions and published term links go with it; media it used stays in the library.
 */
export async function purgeEntry(ctx: SiteContext, entryId: string): Promise<Purged> {
  return inTenant(ctx, async (tx) => {
    const settings = await lockSiteSettings(tx, ctx.org.id, ctx.site.id);
    if (!settings) throw notFound();
    const entry = await findTrashedEntry(tx, ctx.org.id, ctx.site.id, entryId, ENTRY_TRASH_DAYS);
    if (!entry || !visible(ctx, entry)) throw notFound();
    if (!canPurgeEntry(ctx, refOf(entry))) throw forbidden();
    const step = transition(stateOf(entry), "purge");
    if (!step.ok) throw conflict(step.reason);

    const below = await everythingBelow(tx, ctx.org.id, ctx.site.id, entry.id);
    const live = below.filter((row) => !row.trashed);
    if (live.length) throw conflict(`${PAGE_BELOW(live.length)} below it ${live.length === 1 ? "is" : "are"} not in the trash. Nothing was deleted.`);
    await lockEntries(tx, ctx.org.id, ctx.site.id, below.map((row) => row.id));
    const deleted = await deleteTrashed(tx, ctx.org.id, ctx.site.id, [entry.id, ...below.map((row) => row.id)]);
    if (!deleted.includes(entry.id)) throw notFound();
    await record(
      tx,
      {
        action: "entry.deleted", resourceType: "entry", resourceId: entry.id, siteId: ctx.site.id,
        metadata: { type: entry.type, title: titleForLog(entry.title), path: entry.path, below: deleted.length - 1 },
      },
      ctx,
    );
    return { below: deleted.length - 1, events: [] };
  });
}
