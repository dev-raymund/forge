/**
 * Google sign-in: the linking policy and what the login page says when it
 * fails (M2-3). Pure and client-safe: no Better Auth import.
 */

/**
 * Plan §12: Google is linked to an existing account **only** when Google says
 * the address is verified AND the existing account has verified the same
 * address itself. Passed to Better Auth as `account.accountLinking`.
 *
 * - No trusted providers: Google's word counts only together with its
 *   `email_verified` claim, never on the provider's name alone.
 * - The local address must be verified too (Better Auth's default, and not
 *   optional from its next minor version). Without that, someone could
 *   register a victim's address with a password, wait for the victim's first
 *   Google sign-in, and find the two joined.
 * - Different addresses are never linked, and linking never rewrites the
 *   account's name, address or verified state from Google's profile.
 */
export const ACCOUNT_LINKING: {
  enabled: boolean;
  trustedProviders: string[];
  allowDifferentEmails: boolean;
  updateUserInfoOnLink: boolean;
  disableImplicitLinking: boolean;
} = {
  enabled: true,
  trustedProviders: [],
  allowDifferentEmails: false,
  updateUserInfoOnLink: false,
  disableImplicitLinking: false,
};

/** Where Google's authorization page lives. A sign-in never sends the browser anywhere else. */
export const GOOGLE_AUTHORIZE_ORIGIN = "https://accounts.google.com";

export function isGoogleAuthorizeUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).origin === GOOGLE_AUTHORIZE_ORIGIN;
  } catch {
    return false;
  }
}

const NOT_LINKED =
  "This email address already has a Forge account that isn't connected to Google. Log in with your password; once your email address is verified you can use Google as well.";
const CANCELLED = "Google sign-in was cancelled.";
const NO_EMAIL = "Google didn't share an email address, so we couldn't sign you in.";
const GENERIC = "We couldn't sign you in with Google. Please try again.";

/** Better Auth's `?error=` codes that get their own wording. Everything else is the generic message. */
const BY_CODE: Record<string, string> = {
  account_not_linked: NOT_LINKED,
  unable_to_link_account: NOT_LINKED,
  access_denied: CANCELLED,
  email_not_found: NO_EMAIL,
};

/**
 * The message for a failed Google sign-in, from the `?error=` code Better
 * Auth adds to the login page's address. The code itself is never shown: it
 * comes from the URL, so anyone can write anything there.
 */
export function oauthErrorMessage(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : GENERIC;
}

export const OAUTH_MESSAGES = { NOT_LINKED, CANCELLED, NO_EMAIL, GENERIC } as const;
