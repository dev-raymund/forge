import type { Metadata } from "next";
import { Suspense } from "react";
import { OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { activityHref, describeEvent } from "@/modules/audit";
import { canManageSiteSettings, getSiteOverview, sitePath, SiteOverviewView } from "@/modules/sites";
import { canReadActivity, listActivity, orgActivityPath, requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Site" };

/**
 * A site's overview (plan §19: `/{orgSlug}/sites/{siteSlug}`, every member;
 * M4-2): status and public address, how it is set up, the launch checklist,
 * and, for those who may read the activity log, what was done to it lately.
 * Publishing it, and switching it back to Coming soon, is M4-5's (ADR 0015).
 */
export default function SitePage({ params }: PageProps<"/[orgSlug]/sites/[siteSlug]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Site params={params} />
    </Suspense>
  );
}

async function Site({ params }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, sitePath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  const readsActivity = canReadActivity(ctx);
  const [overview, page] = await Promise.all([getSiteOverview(ctx), readsActivity ? listActivity(ctx, { site: ctx.site.id }) : null]);
  const activity = page
    ? page.items.slice(0, 5).map((item) => ({ id: item.id, sentence: describeEvent(item), occurredAt: item.occurredAt.toISOString() }))
    : null;

  return (
    <SiteOverviewView
      orgSlug={ctx.org.slug}
      overview={overview}
      canManage={canManageSiteSettings(ctx)}
      emailVerified={ctx.actor.emailVerified}
      activity={activity}
      activityHref={activityHref(orgActivityPath(ctx.org.slug), { site: ctx.site.id })}
    />
  );
}
