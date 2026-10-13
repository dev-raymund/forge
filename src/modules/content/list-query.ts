/**
 * What the pages and posts lists were asked for, read from their URLs (M5-7; as the activity log's, M3-5). Pure and
 * client-safe. Every value is untrusted: it is reduced to something well-formed or dropped, so a manipulated URL shows
 * less, never more, and never an error page. What a member may see is decided on the server after this.
 */

type Raw = string | string[] | undefined;
const first = (value: Raw): string | undefined => (Array.isArray(value) ? value[0] : value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many posts a page of the list holds. */
export const POSTS_PAGE_SIZE = 25;
/** The longest search text kept. */
export const LIST_SEARCH_MAX = 100;

export const ENTRY_STATUS_FILTERS = ["draft", "published", "scheduled"] as const;
export type EntryStatusFilter = (typeof ENTRY_STATUS_FILTERS)[number];

export const POST_SORTS = { updated: "Recently edited", published: "Recently published", title: "Title (A–Z)", oldest: "Oldest first" } as const;
export type PostSort = keyof typeof POST_SORTS;

export type PageListQuery = { q?: string; status?: EntryStatusFilter };
export type PostListQuery = PageListQuery & { category?: string; author?: string; sort: PostSort; page: number };

const search = (value: Raw) => {
  const text = first(value)?.trim().slice(0, LIST_SEARCH_MAX);
  return text ? text : undefined;
};
const status = (value: Raw) => {
  const text = first(value);
  return (ENTRY_STATUS_FILTERS as readonly string[]).includes(text ?? "") ? (text as EntryStatusFilter) : undefined;
};
const id = (value: Raw) => {
  const text = first(value);
  return text && UUID.test(text) ? text.toLowerCase() : undefined;
};

export function parsePageQuery(params: Record<string, Raw>): PageListQuery {
  return withoutEmpty({ q: search(params.q), status: status(params.status) });
}

export function parsePostQuery(params: Record<string, Raw>): PostListQuery {
  const sort = first(params.sort);
  const page = Number(first(params.page));
  return {
    ...withoutEmpty({ q: search(params.q), status: status(params.status), category: id(params.category), author: id(params.author) }),
    sort: sort && Object.hasOwn(POST_SORTS, sort) ? (sort as PostSort) : "updated",
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** A list's URL for a query: the defaults are left out, so the plain list is the plain path. */
export function listHref(basePath: string, query: Partial<PostListQuery>, change: Partial<PostListQuery> = {}): string {
  const merged = { ...query, ...change };
  const params = new URLSearchParams();
  for (const key of ["q", "status", "category", "author"] as const) if (merged[key]) params.set(key, merged[key]!);
  if (merged.sort && merged.sort !== "updated") params.set("sort", merged.sort);
  if (merged.page && merged.page > 1) params.set("page", String(merged.page));
  const text = params.toString();
  return text ? `${basePath}?${text}` : basePath;
}

export const hasListFilters = (query: Partial<PostListQuery>): boolean => Boolean(query.q || query.status || query.category || query.author);

function withoutEmpty<T extends Record<string, unknown>>(query: T): T {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)) as T;
}
