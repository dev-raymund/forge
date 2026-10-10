import { CircleCheck, CircleDashed, ExternalLink } from "lucide-react";
import Link from "next/link";
import { Moment } from "@/components/admin/local-day";
import { cn } from "@/lib/utils";
import { languageLabel } from "../locale";
import type { SiteOverview } from "../overview.service";
import { STATUS_EXPLANATIONS } from "../overview";
import { siteAppearancePath, siteSettingsPath } from "../paths";
import { SiteStatusControl } from "./site-publishing";
import { SiteStatusBadge } from "./sites-view";

/**
 * A site's overview (M4-2): its status and public address, how it is set up,
 * the launch checklist, and what was done to it lately. A server component;
 * the page passes what the member may open, never a role.
 */

const LINK = "rounded-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25";

export type SiteOverviewProps = {
  orgSlug: string;
  overview: SiteOverview;
  /** Links to the appearance and settings pages, and the Publish button (M4-5), for those who may use them. */
  canManage: boolean;
  /** Whether the member's email address is verified: publishing needs it (plan §2). */
  emailVerified: boolean;
  /** The site's latest events, for those who may read the activity log; null for everyone else. */
  activity: { id: string; sentence: string; occurredAt: string }[] | null;
  activityHref: string;
};

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="grid content-start gap-2 rounded-xl border p-5" aria-label={title}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      <div className="grid gap-1 text-sm">{children}</div>
    </section>
  );
}

export function SiteOverviewView({ orgSlug, overview, canManage, emailVerified, activity, activityHref }: SiteOverviewProps) {
  const { site, publicUrl, theme, reading, analytics, checklist } = overview;
  const settings = siteSettingsPath(orgSlug, site.slug);
  const edit = (href: string, label: string) => (canManage ? <Link href={href} className={cn(LINK, "text-sm")} aria-label={label}>Change</Link> : null);
  const done = checklist.filter((item) => item.done).length;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight wrap-anywhere" data-testid="site-name">
          {site.name}
        </h1>
        <SiteStatusBadge status={site.status} />
      </div>
      {overview.tagline ? <p className="mt-1 text-muted-foreground">{overview.tagline}</p> : null}
      <p className="mt-3 max-w-prose text-sm text-muted-foreground" data-testid="status-explanation">
        {STATUS_EXPLANATIONS[site.status] ?? ""}
      </p>
      {/* A suspended site has no control here: only staff lift a suspension (M12-1). */}
      {canManage && publicUrl && (site.status === "coming_soon" || site.status === "live") ? (
        <SiteStatusControl
          orgSlug={orgSlug}
          siteSlug={site.slug}
          siteName={site.name}
          status={site.status}
          publicUrl={publicUrl}
          mustVerifyEmail={!emailVerified}
        />
      ) : null}

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Public address" action={edit(settings, "Change the site's address")}>
          {site.address && publicUrl ? (
            <a href={publicUrl} className={cn(LINK, "inline-flex items-center gap-1.5 break-all")} data-testid="site-address">
              {publicUrl}
              <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
            </a>
          ) : (
            <p>None</p>
          )}
        </Card>
        <Card title="Theme" action={edit(siteAppearancePath(orgSlug, site.slug), "Change the theme")}>
          <p data-testid="site-theme">{theme.name}</p>
        </Card>
        <Card title="Language and time zone" action={edit(settings, "Change the language and time zone")}>
          <p data-testid="site-language">{languageLabel(site.language)}</p>
          <p data-testid="site-timezone" className="text-muted-foreground">
            {site.timezone.replaceAll("_", " ")}
          </p>
        </Card>
        <Card title="Reading" action={edit(settings, "Change the reading settings")}>
          <p>
            Blog at <span className="font-medium">/{reading.blogPath}</span>, {reading.postsPerPage} posts a page
          </p>
          <p className="text-muted-foreground">Used once the site has posts.</p>
        </Card>
        <Card title="Analytics" action={edit(settings, "Change the analytics settings")}>
          <p data-testid="site-analytics">
            {analytics.ga4 || analytics.plausible
              ? [analytics.ga4 ? "Google Analytics 4" : null, analytics.plausible ? "Plausible" : null].filter(Boolean).join(" and ")
              : "None"}
          </p>
          {analytics.ga4 || analytics.plausible ? <p className="text-muted-foreground">Saved; tracking is not active yet.</p> : null}
        </Card>
        <Card title="Created">
          <p>
            <Moment iso={site.createdAt.toISOString()} />
          </p>
        </Card>
      </div>

      <section aria-labelledby="checklist-heading" className="mt-10">
        <h2 id="checklist-heading" className="text-lg font-semibold tracking-tight">
          Launch checklist
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {done} of {checklist.length} done.
        </p>
        <ol className="mt-4 grid gap-2" data-testid="checklist">
          {checklist.map((item) => (
            <li key={item.key} className="flex items-start gap-3 rounded-lg border px-4 py-3" data-testid="checklist-item" data-done={item.done ? "" : undefined}>
              {item.done ? (
                <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-emerald-700" />
              ) : (
                <CircleDashed aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              )}
              <div className="grid gap-0.5">
                <p className="font-medium">
                  {item.href ? (
                    <Link href={item.href} className={LINK}>
                      {item.label}
                    </Link>
                  ) : (
                    item.label
                  )}
                  <span className="sr-only">{item.done ? " (done)" : " (not done)"}</span>
                </p>
                <p className="text-sm text-muted-foreground">{item.note}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {activity ? (
        <section aria-labelledby="activity-heading" className="mt-10">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="activity-heading" className="text-lg font-semibold tracking-tight">
              Recent activity
            </h2>
            <Link href={activityHref} className={cn(LINK, "text-sm")}>
              All activity
            </Link>
          </div>
          {activity.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ol className="mt-3 grid gap-2" data-testid="site-activity">
              {activity.map((event) => (
                <li key={event.id} className="grid gap-0.5 border-b pb-2 text-sm last:border-b-0">
                  <span>{event.sentence}</span>
                  <span className="text-muted-foreground">
                    <Moment iso={event.occurredAt} />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </main>
  );
}
