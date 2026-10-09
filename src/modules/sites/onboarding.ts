/**
 * Where onboarding resumes (M4-2; plan §3: org → site → theme, resumable).
 * Pure. The progress is what the database already says, not a stored step:
 *
 *   no organization                                 step 1   /onboarding
 *   an organization without a site, and the member
 *   may create one                                  step 2   /onboarding/{orgSlug}
 *   anything else                                   done     the organization's sites
 *
 * Step 3 (the theme) follows step 2 in the browser. It needs no resuming: a
 * site already has a theme (Studio), and the same picker is on its
 * Appearance page.
 */
export type OnboardingState = { home: { slug: string } | null; sitesInHome: number; canCreateSites: boolean };

export type OnboardingNext = { step: "organization" } | { step: "site"; orgSlug: string } | { step: "done"; orgSlug: string };

export function onboardingNext(state: OnboardingState): OnboardingNext {
  if (!state.home) return { step: "organization" };
  if (state.sitesInHome === 0 && state.canCreateSites) return { step: "site", orgSlug: state.home.slug };
  return { step: "done", orgSlug: state.home.slug };
}

/** The three steps, for the indicator at the top of each. */
export const ONBOARDING_STEPS = ["Organization", "Site", "Theme"] as const;
