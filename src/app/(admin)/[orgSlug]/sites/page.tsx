import type { Metadata } from "next";
import { Suspense } from "react";
import { OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { canCreateSite, listSites, siteAllowance, SITES_NOTICES, SitesView } from "@/modules/sites";
import { orgSitesPath, requireOrgPage, ROLE_LABELS } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Sites" };

/**
 * An organization's sites (plan §19), and its home since M4-1: `/{orgSlug}`
 * and `/` lead here. Every member sees the list; the way to create a site, and
 * how much of the plan's allowance is used, only for those who may create one.
 *
 * Rendered per request, from the member's own context. Nothing here is cached
 * for anyone else.
 */
export default function SitesPage({ params, searchParams }: PageProps<"/[orgSlug]/sites">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Sites params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Sites({ params, searchParams }: PageProps<"/[orgSlug]/sites">) {
  const [{ orgSlug }, query] = await Promise.all([params, searchParams]);
  const access = await requireOrgPage(orgSlug, orgSitesPath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  const [sites, allowance] = await Promise.all([listSites(ctx), canCreateSite(ctx) ? siteAllowance(ctx) : null]);
  return (
    <SitesView
      organization={{ name: ctx.org.name, slug: ctx.org.slug }}
      role={ROLE_LABELS[ctx.membership.role]}
      sites={sites}
      allowance={allowance}
      notice={SITES_NOTICES.find((value) => value === query.done)}
    />
  );
}
