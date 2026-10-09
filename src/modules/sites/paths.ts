import { siteBasePath } from "@/platform/routing/hosts";

/**
 * The URLs of a site, in the admin and in public. Client-safe: plain strings,
 * so client forms can show them without importing the tenancy module.
 * `/{orgSlug}/sites` itself is the tenancy module's `orgSitesPath`.
 */

export const newSitePath = (orgSlug: string): string => `/${orgSlug}/sites/new`;

export const sitePath = (orgSlug: string, siteSlug: string): string => `/${orgSlug}/sites/${siteSlug}`;

export const siteSettingsPath = (orgSlug: string, siteSlug: string): string => `${sitePath(orgSlug, siteSlug)}/settings`;

export const siteAppearancePath = (orgSlug: string, siteSlug: string): string => `${sitePath(orgSlug, siteSlug)}/appearance`;

/** Onboarding, step 3 (M4-2): the new site's theme. Step 2 is the tenancy module's `onboardingSitePath`. */
export const onboardingThemePath = (orgSlug: string, siteSlug: string): string => `/onboarding/${orgSlug}/${siteSlug}`;

/** Where the public can see the site: `/s/{address}` on the V1 host (ADR 0006). */
export const publicSitePath = (address: string): string => siteBasePath({ kind: "address", address });
