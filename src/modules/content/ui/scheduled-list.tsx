import Link from "next/link";
import { entryEditorPath } from "../admin-paths";
import type { ScheduledItem } from "../queries";
import { formatInZone } from "../zoned-time";

/**
 * What is scheduled on a site (M7-2; the site's overview): each page and post with when it publishes, in the site's time
 * zone (named), soonest first; and those whose schedule failed lately, with why. Links go to their editors.
 */

const LINK = "rounded-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25";

export function ScheduledList({ orgSlug, siteSlug, items, timeZone }: { orgSlug: string; siteSlug: string; items: ScheduledItem[]; timeZone: string }) {
  return (
    <section aria-labelledby="scheduled-heading" className="mt-10" data-testid="scheduled">
      <h2 id="scheduled-heading" className="text-lg font-semibold tracking-tight">
        Scheduled
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">Times are in the site&rsquo;s time zone, {timeZone}.</p>
      {items.length ? (
        <ol className="mt-3 grid gap-2">
          {items.map((item) => (
            <li key={item.id} className="grid gap-0.5 border-b pb-2 text-sm last:border-b-0" data-testid="scheduled-item" data-state={item.failure ? "failed" : "scheduled"}>
              <Link href={entryEditorPath(orgSlug, siteSlug, item.type, item.id)} className={`${LINK} wrap-anywhere`}>
                {item.title}
              </Link>
              {item.failure ? (
                <span className="text-destructive">Not published as scheduled: {item.failure.reason}</span>
              ) : (
                <span className="text-muted-foreground">
                  {item.type === "page" ? "Page" : "Post"} · publishes {formatInZone(new Date(item.scheduledAt!), timeZone)}
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="nothing-scheduled">
          Nothing is scheduled.
        </p>
      )}
    </section>
  );
}
