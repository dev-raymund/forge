import type { Metadata } from "next";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { ActivityView, parseActivityQuery } from "@/modules/audit";
import { listSites } from "@/modules/sites";
import { canReadActivity, listActivity, listMembers, orgActivityPath, requireOrgPage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Activity" };

/**
 * An organization's activity log (plan §19): what was done in it, by whom.
 * For members who hold `org.activity.read` (Owner and Admin). The page says
 * "no access" to anyone else, and the query behind it checks for itself.
 *
 * The organization is the one in the URL, resolved against the session's
 * membership like every page here. The filters and the page cursor come from
 * the query string and can only narrow what is shown inside that organization.
 */
export default function OrganizationActivityPage({ params, searchParams }: PageProps<"/[orgSlug]/activity">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <OrganizationActivity params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function OrganizationActivity({ params, searchParams }: PageProps<"/[orgSlug]/activity">) {
  const [{ orgSlug }, filters] = await Promise.all([params, searchParams]);
  const access = await requireOrgPage(orgSlug, orgActivityPath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  if (!canReadActivity(ctx)) {
    return (
      <NoAccess>
        <p>The activity log is for Owners and Admins of {ctx.org.name}.</p>
      </NoAccess>
    );
  }

  const query = parseActivityQuery(filters);
  const [page, members, sites] = await Promise.all([listActivity(ctx, query), listMembers(ctx), listSites(ctx)]);
  return (
    <ActivityView
      basePath={orgActivityPath(ctx.org.slug)}
      query={query}
      page={page}
      members={members.map((member) => ({ id: member.id, name: member.name }))}
      sites={sites.map((site) => ({ id: site.id, name: site.name }))}
    />
  );
}
