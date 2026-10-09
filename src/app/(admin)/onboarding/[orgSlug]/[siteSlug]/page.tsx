import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader } from "@/components/admin/app-header";
import { OnboardingFrame } from "@/components/admin/onboarding-frame";
import { OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton, ShellSkeleton } from "@/components/admin/page-skeleton";
import { VerifyEmailBanner } from "@/modules/auth";
import { canManageAppearance, getAppearance, ONBOARDING_STEPS, onboardingThemePath, sitePath, ThemePicker } from "@/modules/sites";
import { requireSitePage } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Choose a theme" };

/**
 * Onboarding, step 3 (M4-2): the new site's theme, with the same picker and
 * action as the site's Appearance page (M4-4). The site already has Studio,
 * so this step can be left at any point; "Continue" goes to the site.
 */
export default function OnboardingThemePage({ params }: PageProps<"/onboarding/[orgSlug]/[siteSlug]">) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh flex-col">
          <ShellSkeleton />
          <PageSkeleton narrow />
        </div>
      }
    >
      <OnboardingTheme params={params} />
    </Suspense>
  );
}

async function OnboardingTheme({ params }: Pick<PageProps<"/onboarding/[orgSlug]/[siteSlug]">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, onboardingThemePath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx, user } = access;
  const overview = sitePath(ctx.org.slug, ctx.site.slug);
  if (!canManageAppearance(ctx)) redirect(overview);
  const appearance = await getAppearance(ctx);

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader user={user} />
      {user.emailVerified ? null : <VerifyEmailBanner />}
      <OnboardingFrame
        steps={ONBOARDING_STEPS}
        current={3}
        title="Choose a theme"
        description={<>How {ctx.site.name} looks. You can change it any time on the site&rsquo;s Appearance page; your content stays as it is.</>}
      >
        <div className="grid gap-6">
          <ThemePicker orgSlug={ctx.org.slug} siteSlug={ctx.site.slug} themes={appearance.themes} active={appearance.theme} />
          <Link
            href={overview}
            className="inline-flex h-10 items-center justify-center justify-self-start rounded-lg border px-4 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-foreground/40"
          >
            Continue to your site
          </Link>
        </div>
      </OnboardingFrame>
    </div>
  );
}
