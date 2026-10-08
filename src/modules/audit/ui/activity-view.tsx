import Link from "next/link";
import { Moment } from "@/components/admin/local-day";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { ActivityPage } from "../activity";
import { activityHref, hasFilters, type ActivityQuery } from "../activity-query";
import { AUDIT_ACTIONS, describeEvent, eventLabel } from "../events";

/**
 * An organization's activity log: what was done, by whom, when (M3-5).
 *
 * Every line is a sentence built from the stored event (../events.ts). The
 * page shows no ids, no client addresses and no request ids: those are kept
 * for security work and are not selected by the query behind this page.
 *
 * The filters are an ordinary GET form: the list is whatever the URL says, and
 * works without JavaScript. Pages are reached by a cursor in the URL, so a
 * page never loads more than its share of a log that only grows.
 */

const CONTROL =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 md:text-sm";
const LINK = "rounded-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25";

export type ActivityViewProps = {
  /** The page's own path (`/{org}/activity`). Filters and pages are query strings on it. */
  basePath: string;
  query: ActivityQuery;
  page: ActivityPage;
  /** Who can be filtered by: membership id and name. */
  members: { id: string; name: string }[];
  /** The organization's sites, to narrow the log to one (M4-1). The filter is not shown while there are none. */
  sites?: { id: string; name: string }[];
};

export function ActivityView({ basePath, query, page, members, sites = [] }: ActivityViewProps) {
  const filtered = hasFilters(query);
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">What has been done in this organization, newest first. The record cannot be edited or deleted.</p>

      {/* Keyed by the filters in the URL: when a link changes them, the fields start again from what the URL now says,
          instead of keeping what was last chosen in them. */}
      <form
        key={activityHref("", { ...query, before: undefined })}
        method="get"
        action={basePath}
        className="mt-8 grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
        aria-label="Filter activity"
      >
        <div className="grid gap-2">
          <Label htmlFor="activity-action">Event</Label>
          <select id="activity-action" name="action" defaultValue={query.action ?? ""} className={CONTROL}>
            <option value="">All events</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {eventLabel(action)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="activity-member">Done by</Label>
          <select id="activity-member" name="member" defaultValue={query.member ?? ""} className={CONTROL}>
            <option value="">Anyone</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </div>
        {sites.length > 0 ? (
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor="activity-site">Site</Label>
            <select id="activity-site" name="site" defaultValue={query.site ?? ""} className={CONTROL}>
              <option value="">Every site, and the organization</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="grid gap-2">
          <Label htmlFor="activity-from">From</Label>
          <input id="activity-from" name="from" type="date" defaultValue={query.from ?? ""} className={CONTROL} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="activity-to">To</Label>
          <input id="activity-to" name="to" type="date" defaultValue={query.to ?? ""} className={CONTROL} />
        </div>
        <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
          <Button type="submit" className="h-10 px-4 focus-visible:ring-foreground/40">
            Apply filters
          </Button>
          {filtered ? (
            <Link href={basePath} className={`${LINK} text-sm`}>
              Clear filters
            </Link>
          ) : null}
          <span className="text-sm text-muted-foreground">Days are counted in UTC.</span>
        </div>
      </form>

      {page.items.length > 0 ? (
        <ol className="mt-8 divide-y rounded-lg border" data-testid="activity">
          {page.items.map((event) => (
            <li key={event.id} data-testid="event" data-action={event.action} className="grid gap-1 p-3 sm:p-4">
              <p className="wrap-anywhere text-sm">{describeEvent(event)}</p>
              <p className="text-sm text-muted-foreground">
                <Moment iso={event.occurredAt.toISOString()} />
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-8 rounded-lg border border-dashed p-6 text-sm text-muted-foreground" data-testid="no-activity">
          {filtered || query.before ? "No activity matches these filters." : "Nothing has been recorded yet."}
        </p>
      )}

      {query.before || page.nextCursor ? (
        <nav aria-label="Pages of activity" className="mt-6 flex flex-wrap items-center justify-between gap-4 text-sm">
          {query.before ? (
            <Link href={activityHref(basePath, query, { before: undefined })} className={LINK}>
              Back to the newest
            </Link>
          ) : (
            <span />
          )}
          {page.nextCursor ? (
            <Link href={activityHref(basePath, query, { before: page.nextCursor })} className={LINK} rel="next">
              Older activity
            </Link>
          ) : null}
        </nav>
      ) : null}
    </main>
  );
}
