import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader } from "@/components/admin/app-header";
import { OnboardingFrame } from "@/components/admin/onboarding-frame";
import { OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton, ShellSkeleton } from "@/components/admin/page-skeleton";
import { VerifyEmailBanner } from "@/modules/auth";
import { canCreateSite, CreateSiteForm, listSites, ONBOARDING_STEPS, siteTimeZones } from "@/modules/sites";
import { onboardingSitePath, orgSitesPath, requireOrgPage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Create your site" };

/**
 * Onboarding, step 2 (M4-2): the organization's first site, with the same form
 * and action as `/{orgSlug}/sites/new`; only where it goes next differs (step
 * 3). The organization is the one in the URL, checked against the member's
 * membership like every admin page. Someone who may not create sites, or whose
 * organization already has one, has nothing to do here and goes to its sites.
 */
export default function OnboardingSitePage({ params }: PageProps<"/onboarding/[orgSlug]">) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh flex-col">
          <ShellSkeleton />
          <PageSkeleton narrow />
        </div>
      }
    >
      <OnboardingSite params={params} />
    </Suspense>
  );
}

async function OnboardingSite({ params }: Pick<PageProps<"/onboarding/[orgSlug]">, "params">) {
  const { orgSlug } = await params;
  const access = await requireOrgPage(orgSlug, onboardingSitePath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx, user } = access;
  if (!canCreateSite(ctx) || (await listSites(ctx)).length > 0) redirect(orgSitesPath(ctx.org.slug));

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader user={user} />
      {user.emailVerified ? null : <VerifyEmailBanner />}
      <OnboardingFrame
        steps={ONBOARDING_STEPS}
        current={2}
        title="Create your site"
        description={<>The first website of {ctx.org.name}. It starts as Coming soon: visitors see a holding page until you publish it.</>}
      >
        <CreateSiteForm orgSlug={ctx.org.slug} timeZones={siteTimeZones()} flow="onboarding" />
      </OnboardingFrame>
    </div>
  );
}
