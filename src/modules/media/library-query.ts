/**
 * What the media library was asked for, read from its URL (M6-3; as the content lists', M5-7). Pure and client-safe.
 * Every value is untrusted: reduced to something well-formed or dropped, so a manipulated URL shows less, never more,
 * and never an error page. What a member may see is decided on the server after this.
 */

type Raw = string | string[] | undefined;
const first = (value: Raw): string | undefined => (Array.isArray(value) ? value[0] : value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many items a page of the library holds. */
export const LIBRARY_PAGE_SIZE = 48;
export const LIBRARY_SEARCH_MAX = 100;

export const LIBRARY_SORTS = { newest: "Newest first", name: "Name (A–Z)", size: "Largest first" } as const;
export type LibrarySort = keyof typeof LIBRARY_SORTS;
export const LIBRARY_KINDS = { image: "Images", document: "PDFs" } as const;
export type LibraryKind = keyof typeof LIBRARY_KINDS;

export type LibraryQuery = {
  q?: string;
  kind?: LibraryKind;
  /** A folder's id, or `none` (files in no folder). Absent: all media. */
  folder?: string;
  sort: LibrarySort;
  view: "grid" | "list";
  /** The trash instead of the library. */
  trash: boolean;
  page: number;
};

export function parseLibraryQuery(params: Record<string, Raw>): LibraryQuery {
  const q = first(params.q)?.trim().slice(0, LIBRARY_SEARCH_MAX);
  const kind = first(params.kind);
  const folder = first(params.folder);
  const sort = first(params.sort);
  const page = Number(first(params.page));
  return {
    ...(q ? { q } : {}),
    ...(kind && Object.hasOwn(LIBRARY_KINDS, kind) ? { kind: kind as LibraryKind } : {}),
    ...(folder === "none" ? { folder } : folder && UUID.test(folder) ? { folder: folder.toLowerCase() } : {}),
    sort: sort && Object.hasOwn(LIBRARY_SORTS, sort) ? (sort as LibrarySort) : "newest",
    view: first(params.view) === "list" ? "list" : "grid",
    trash: first(params.trash) === "1",
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** The library's URL for a query: the defaults are left out, so the plain library is the plain path. */
export function libraryHref(basePath: string, query: Partial<LibraryQuery>, change: Partial<LibraryQuery> = {}): string {
  const merged: Partial<LibraryQuery> = { ...query, ...change };
  const params = new URLSearchParams();
  if (merged.trash) params.set("trash", "1");
  for (const key of ["q", "kind", "folder"] as const) if (merged[key]) params.set(key, merged[key]!);
  if (merged.sort && merged.sort !== "newest") params.set("sort", merged.sort);
  if (merged.view === "list") params.set("view", "list");
  if (merged.page && merged.page > 1) params.set("page", String(merged.page));
  const text = params.toString();
  return text ? `${basePath}?${text}` : basePath;
}
