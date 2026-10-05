/**
 * Admin URLs of an organization. The organization is always in the URL (D-08):
 * these are the only places that spell those URLs out. Client-safe.
 */

export const ONBOARDING_PATH = "/onboarding";

/** The organization's home. */
export const orgPath = (orgSlug: string): string => `/${orgSlug}`;

export const orgSettingsPath = (orgSlug: string): string => `/${orgSlug}/settings`;
