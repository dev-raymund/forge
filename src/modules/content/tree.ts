import "server-only";
import type { TenantTx } from "@/platform/db";
import { isUniqueViolation } from "@/platform/db";
import { conflict } from "@/platform/errors";
import { HOME_PATH, pathUnder } from "./paths";
import { descendantsOf, updateEntry } from "./repository";
import type { SiteScope } from "./scope";
import { ENTRY_PATH_KEY } from "./unique-slug";

/**
 * Keeping a page tree's paths true (M5-3; cms-architecture §12.7 "path changes
 * … recompute descendants' paths in the same transaction"). A page's path is
 * its parent's path and its slug, so when a page's path changes, every page
 * below it changes with it. Redirects from the old paths are M8-5's.
 */

export type MovedEntry = { id: string; type: string; status: string; title: string; from: string; to: string };

/**
 * Gives every page below `rootId` (not in the trash) the path its place in
 * the tree implies, now that the root's path is `rootPath`; shallowest first,
 * so each page's parent already has its new path. A page under the Home page
 * sits at the top level, and a Home page below another page keeps `/`.
 *
 * If a new path is already another entry's, the unique key refuses it and
 * the request fails with a Conflict naming the path: the transaction is not
 * committed, so no page has moved.
 */
export async function moveSubtree(tx: TenantTx, ctx: SiteScope, rootId: string, rootPath: string): Promise<MovedEntry[]> {
  const rows = await descendantsOf(tx, ctx.org.id, ctx.site.id, rootId);
  const pathOf = new Map<string, string>([[rootId, rootPath]]);
  const moved: MovedEntry[] = [];
  for (const row of rows) {
    const parentPath = row.parentId ? pathOf.get(row.parentId) : undefined;
    if (parentPath === undefined) throw new Error(`Page ${row.id} came before its parent`);
    const path = row.path === HOME_PATH ? HOME_PATH : pathUnder(parentPath, row.slug);
    pathOf.set(row.id, path);
    if (path === row.path) continue;
    await withPathTaken(path, () => updateEntry(tx, ctx.org.id, ctx.site.id, row.id, { path }));
    moved.push({ id: row.id, type: row.type, status: row.status, title: row.title, from: row.path, to: path });
  }
  return moved;
}

/** Runs a write that gives an entry `path`; another entry holding it becomes a Conflict that says which address. */
export async function withPathTaken<T>(path: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error, ENTRY_PATH_KEY)) throw conflict(`The address ${path} is already used by another page or post. Change the slug and try again.`);
    throw error;
  }
}
