/**
 * Admin URLs of an organization. The organization is always in the URL (D-08):
 * these are the only places that spell those URLs out. Client-safe.
 */

export const ONBOARDING_PATH = "/onboarding";

/** The organization's home. */
export const orgPath = (orgSlug: string): string => `/${orgSlug}`;

export const orgSettingsPath = (orgSlug: string): string => `/${orgSlug}/settings`;

export const orgMembersPath = (orgSlug: string): string => `/${orgSlug}/members`;

/** Where an invitation link leads. The token is the only thing in it. */
export const invitationPath = (token: string): string => `/invite/${token}`;
