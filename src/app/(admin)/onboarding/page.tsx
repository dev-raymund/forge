import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader } from "@/components/admin/app-header";
import { OnboardingFrame } from "@/components/admin/onboarding-frame";
import { PageSkeleton, ShellSkeleton } from "@/components/admin/page-skeleton";
import { requireAuthOrLogin, toActor, VerifyEmailBanner } from "@/modules/auth";
import { TRIAL_DAYS } from "@/modules/billing";
import { canCreateSite, listSites, ONBOARDING_STEPS, onboardingNext } from "@/modules/sites";
import { CreateOrganizationForm, homeOrganization, ONBOARDING_PATH, onboardingSitePath, orgSitesPath, resolveOrgContext } from "@/modules/tenancy";
import { isAppError } from "@/platform/errors";

export const metadata: Metadata = { title: "Create your organization" };

/**
 * Onboarding (plan §3: organization → site → theme, resumable). This page is
 * step 1: a signed-in user with no organization creates one and becomes its
 * Owner, then goes on to step 2 (`/onboarding/{orgSlug}`) and step 3
 * (`/onboarding/{orgSlug}/{siteSlug}`).
 *
 * Coming back here resumes (M4-2): someone whose organization has no site yet,
 * and who may create one, continues at step 2; anyone further along goes to
 * their organization's sites. Nothing is stored about it: the organization
 * and its sites are the progress.
 */
export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh flex-col">
          <ShellSkeleton />
          <PageSkeleton narrow />
        </div>
      }
    >
      <Onboarding />
    </Suspense>
  );
}

/** Request-time: the session, and whether this user already belongs somewhere. */
async function Onboarding() {
  const auth = await requireAuthOrLogin(ONBOARDING_PATH);
  const actor = toActor(auth);
  const home = await homeOrganization(actor);
  if (home) {
    const next = onboardingNext({ home, ...(await progressIn(actor, home.slug)) });
    redirect(next.step === "site" ? onboardingSitePath(next.orgSlug) : orgSitesPath(home.slug));
  }

  const { user } = auth;
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader user={user} />
      {user.emailVerified ? null : <VerifyEmailBanner />}
      <OnboardingFrame
        steps={ONBOARDING_STEPS}
        current={1}
        title="Create your organization"
        description="An organization is where your team works in Forge. It holds your sites, the people you invite, and billing."
      >
        <CreateOrganizationForm trialDays={TRIAL_DAYS} />
      </OnboardingFrame>
    </div>
  );
}

/** How far the member's organization is: its sites, and whether they may create one. A suspended organization is done. */
async function progressIn(actor: ReturnType<typeof toActor>, orgSlug: string): Promise<{ sitesInHome: number; canCreateSites: boolean }> {
  try {
    const ctx = await resolveOrgContext(actor, orgSlug);
    return { sitesInHome: (await listSites(ctx)).length, canCreateSites: canCreateSite(ctx) };
  } catch (error) {
    if (isAppError(error)) return { sitesInHome: 0, canCreateSites: false };
    throw error;
  }
}
