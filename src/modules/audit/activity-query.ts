import { isAuditAction, type AuditAction } from "./events";

/**
 * What the activity page was asked for, read from its URL (pure, client-safe).
 * Every value is untrusted and is either reduced to something well-formed or
 * dropped: a manipulated URL shows less, never more, and never an error page.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** How many events a page holds. The log grows without end; a page does not. */
export const ACTIVITY_PAGE_SIZE = 25;

export type ActivityQuery = {
  action?: AuditAction;
  /** Whose events: a membership id of this organization. Resolved to a user on the server, inside the organization. */
  member?: string;
  /** For site-level events (M4 onward). */
  site?: string;
  /** Calendar days, `YYYY-MM-DD`, both inclusive, in UTC. */
  from?: string;
  to?: string;
  /** Where the previous page ended (an opaque cursor). */
  before?: string;
};

type Raw = string | string[] | undefined;
const first = (value: Raw): string | undefined => (Array.isArray(value) ? value[0] : value);

/** A real calendar day, or nothing: `2026-02-30` is not one. */
function day(value: string | undefined): string | undefined {
  const match = value ? DAY.exec(value) : null;
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? value : undefined;
}

export function parseActivityQuery(params: Record<string, Raw>): ActivityQuery {
  const action = first(params.action);
  const member = first(params.member);
  const site = first(params.site);
  const before = first(params.before);
  const query: ActivityQuery = {
    action: isAuditAction(action) ? action : undefined,
    member: member && UUID.test(member) ? member.toLowerCase() : undefined,
    site: site && UUID.test(site) ? site.toLowerCase() : undefined,
    from: day(first(params.from)),
    to: day(first(params.to)),
    before: before && decodeCursor(before) ? before : undefined,
  };
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)) as ActivityQuery;
}

/** The time span a `from`/`to` pair covers: from the start of the first day to the start of the day after the last. */
export function dayRange(query: Pick<ActivityQuery, "from" | "to">): { from?: Date; before?: Date } {
  const start = (value: string) => new Date(`${value}T00:00:00.000Z`);
  return {
    from: query.from ? start(query.from) : undefined,
    before: query.to ? new Date(start(query.to).getTime() + 24 * 3600 * 1000) : undefined,
  };
}

/** The same filters as a query string, for a link to another page of the same list. */
export function activityHref(basePath: string, query: ActivityQuery, change: Partial<ActivityQuery> = {}): string {
  const merged = { ...query, ...change };
  const params = new URLSearchParams();
  for (const key of ["action", "member", "site", "from", "to", "before"] as const) {
    const value = merged[key];
    if (value) params.set(key, value);
  }
  const search = params.toString();
  return search ? `${basePath}?${search}` : basePath;
}

export const hasFilters = (query: ActivityQuery): boolean => Boolean(query.action || query.member || query.site || query.from || query.to);

// ── The cursor ───────────────────────────────────────────────────────────────

/**
 * Where a page ended: the last event's time and id. The time is in whole
 * microseconds, as Postgres keeps it: a JavaScript date keeps milliseconds
 * only, and a cursor rounded to those would skip or repeat events written in
 * the same millisecond.
 */
export type ActivityCursor = { micros: string; id: string };

const CURSOR = /^(\d{13,19})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const encodeCursor = (cursor: ActivityCursor): string => `${cursor.micros}_${cursor.id}`;

export function decodeCursor(value: unknown): ActivityCursor | null {
  const match = typeof value === "string" ? CURSOR.exec(value) : null;
  return match ? { micros: match[1]!, id: match[2]! } : null;
}
