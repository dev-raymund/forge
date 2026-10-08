import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { NoAccess, OrganizationSuspended, PageNotice } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { hasRoomFor, limitMessage } from "@/modules/billing";
import { canCreateSite, CreateSiteForm, newSitePath, siteAllowance, siteTimeZones } from "@/modules/sites";
import { orgSitesPath, requireOrgPage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Create a site" };

/**
 * Create a site (plan §19: `/{orgSlug}/sites/new`, Owner and Admin). The page
 * shows the form only to someone who may create a site, while the plan has
 * room for one. Both are asked again when the form is submitted: this page
 * only decides what to show.
 */
export default function NewSitePage({ params }: PageProps<"/[orgSlug]/sites/new">) {
  return (
    <Suspense fallback={<PageSkeleton narrow />}>
      <NewSite params={params} />
    </Suspense>
  );
}

async function NewSite({ params }: Pick<PageProps<"/[orgSlug]/sites/new">, "params">) {
  const { orgSlug } = await params;
  const access = await requireOrgPage(orgSlug, newSitePath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  const back = (
    <p>
      <Link href={orgSitesPath(ctx.org.slug)}>Back to the sites</Link>
    </p>
  );
  if (!canCreateSite(ctx)) {
    return (
      <NoAccess>
        <p>Creating sites is for Owners and Admins of {ctx.org.name}.</p>
        {back}
      </NoAccess>
    );
  }
  const allowance = await siteAllowance(ctx);
  if (!hasRoomFor(allowance)) {
    return (
      <PageNotice title="No room for another site" testId="site-limit">
        <p>{limitMessage(allowance)} An Owner can delete a site to make room.</p>
        {back}
      </PageNotice>
    );
  }

  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Create a site</h1>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">In {ctx.org.name}. You can change the name, language and time zone later.</p>
      <CreateSiteForm orgSlug={ctx.org.slug} timeZones={siteTimeZones()} />
    </main>
  );
}
