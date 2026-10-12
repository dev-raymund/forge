/**
 * Entry paths (M5-2; plan §5). Pure and client-safe.
 *
 *   page   /{parent-path}/{slug}          the Home page is `/`
 *   post   /{blogPath}/{slug}             blogPath from the reading settings (default `blog`)
 *
 * The path is stored on the entry (`entries.path`), so any entry resolves with
 * one indexed lookup on `(site_id, locale, path)` (cms-architecture §12.7).
 * The table's CHECK `entries_path_format` accepts exactly what `isEntryPath`
 * accepts: `/`, or one or more `/segment`s.
 */

export const HOME_PATH = "/";

const SEGMENTS = /^(\/[a-z0-9]+(-[a-z0-9]+)*)+$/;

export const isEntryPath = (path: string): boolean => path === HOME_PATH || SEGMENTS.test(path);

/** A slug placed under a path: the top level when that is `""` or `/` (a page under Home sits at the top level). */
export function pathUnder(dir: string, slug: string): string {
  return dir === "" || dir === HOME_PATH ? `/${slug}` : `${dir}/${slug}`;
}

/** A page's path: `/` for the Home page, otherwise its slug under its parent's path (or the top level). */
export function pagePath(page: { slug: string; home?: boolean }, parentPath: string | null): string {
  return page.home ? HOME_PATH : pathUnder(parentPath ?? "", page.slug);
}

/** A post's path: its slug under the blog's path. A post is never the Home page and never has a parent (CHECK `entries_only_pages_nest`). */
export function postPath(slug: string, blogPath: string): string {
  return pathUnder(`/${blogPath}`, slug);
}

// ── Parent chains ────────────────────────────────────────────────────────────

export type PageNode = { id: string; slug: string; parentId: string | null; home?: boolean };

export class ParentChainError extends Error {
  constructor(readonly reason: "cycle" | "missing", readonly at: string) {
    super(reason === "cycle" ? `The pages above ${at} form a loop.` : `A page above ${at} does not exist.`);
    this.name = "ParentChainError";
  }
}

/**
 * The page and every page above it, from the top level down to the page. `find`
 * looks a page up by id (in M5-3, from the same site's rows). A loop or a
 * missing parent is a `ParentChainError`: neither can be given a path.
 */
export function parentChain(id: string, find: (id: string) => PageNode | undefined): PageNode[] {
  const chain: PageNode[] = [];
  const seen = new Set<string>();
  for (let at: string | null = id; at !== null; ) {
    if (seen.has(at)) throw new ParentChainError("cycle", id);
    seen.add(at);
    const node = find(at);
    if (!node) throw new ParentChainError("missing", id);
    chain.push(node);
    at = node.parentId;
  }
  return chain.reverse();
}

/** The path of the last page of a chain (top level → page), built from every slug in it. */
export function pathFromChain(chain: readonly PageNode[]): string {
  if (chain.length === 0) throw new Error("A chain of no pages has no path.");
  return chain.reduce<string | null>((parentPath, node) => pagePath(node, parentPath), null)!;
}

/** Would giving `pageId` this parent put it below itself? Then the move must be refused. */
export function wouldCreateCycle(pageId: string, parentId: string | null, find: (id: string) => PageNode | undefined): boolean {
  if (parentId === null) return false;
  try {
    return parentChain(parentId, find).some((node) => node.id === pageId);
  } catch (error) {
    if (error instanceof ParentChainError && error.reason === "cycle") return true;
    throw error;
  }
}

// ── Reserved paths ───────────────────────────────────────────────────────────

/**
 * Paths that belong to the platform on every site (plan §0, §10):
 * `/_forge/…` (draft preview), the sitemap and robots.txt. A slug cannot spell
 * any of them (no `_`, no `.`), so this guards paths that are not built from a
 * slug: redirects' sources (M8), imports.
 */
export const RESERVED_PATHS: readonly string[] = ["/_forge", "/sitemap.xml", "/robots.txt"];

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Why an entry may not have this path, or null if it may. A page may not take
 * the blog's path or anything under it: those are the posts and their
 * archives (`/{blogPath}`, `/{blogPath}/{slug}`, `/{blogPath}/category/…`).
 * A post's path is always under the blog's, by construction (`postPath`).
 */
export function reservedPathReason(path: string, entry: { type: "page" | "post"; blogPath: string }): string | null {
  if (RESERVED_PATHS.some((root) => within(path, root))) return "That address is used by Forge on every site.";
  if (entry.type === "page" && within(path, `/${entry.blogPath}`)) return `That address belongs to the blog (/${entry.blogPath}).`;
  return null;
}
