/**
 * Admin URLs of an organization. The organization is always in the URL (D-08):
 * these are the only places that spell those URLs out. Client-safe.
 */

export const ONBOARDING_PATH = "/onboarding";

/**
 * The organization's own URL, as people type and read it. Since M4-1 it is a
 * redirect to its sites (plan §19): link to `orgSitesPath`, not here.
 */
export const orgPath = (orgSlug: string): string => `/${orgSlug}`;

/** The organization's sites: where a member lands, and what its links lead to (M4-1). */
export const orgSitesPath = (orgSlug: string): string => `/${orgSlug}/sites`;

export const orgSettingsPath = (orgSlug: string): string => `/${orgSlug}/settings`;

export const orgMembersPath = (orgSlug: string): string => `/${orgSlug}/members`;

export const orgActivityPath = (orgSlug: string): string => `/${orgSlug}/activity`;

/** Where an invitation link leads. The token is the only thing in it. */
export const invitationPath = (token: string): string => `/invite/${token}`;
