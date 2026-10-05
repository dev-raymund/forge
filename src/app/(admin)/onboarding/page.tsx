import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader } from "@/components/admin/app-header";
import { PageSkeleton, ShellSkeleton } from "@/components/admin/page-skeleton";
import { requireAuthOrLogin, toActor, VerifyEmailBanner } from "@/modules/auth";
import { TRIAL_DAYS } from "@/modules/billing";
import { CreateOrganizationForm, homeOrganization, ONBOARDING_PATH, orgPath } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Create your organization" };

/**
 * Onboarding, step 1 (plan §3): a signed-in user with no organization creates
 * one and becomes its Owner. Steps 2 and 3 (site, theme) are M4-2.
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
  // This screen is the first run. Someone who already has an organization goes to it.
  const existing = await homeOrganization(toActor(auth));
  if (existing) redirect(orgPath(existing.slug));

  const { user } = auth;
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader user={user} />
      {user.emailVerified ? null : <VerifyEmailBanner />}
      <main className="mx-auto w-full max-w-md flex-1 px-4 py-10 sm:px-6 sm:py-16">
        <header className="mb-8 grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">Create your organization</h1>
          <p className="text-muted-foreground">An organization is where your team works in Forge. It holds your sites, the people you invite, and billing.</p>
        </header>
        <CreateOrganizationForm trialDays={TRIAL_DAYS} />
      </main>
    </div>
  );
}
