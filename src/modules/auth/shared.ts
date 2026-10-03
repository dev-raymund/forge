/**
 * Client-safe auth types and constants. Everything the rest of Forge knows
 * about a signed-in user comes from here; Better Auth's own types stay inside
 * modules/auth (D-07, lint-enforced).
 */

/** Plan §12. */
export const MIN_PASSWORD_LENGTH = 12;

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
};

export type AuthSession = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
};

/** A signed-in request: who, and through which session. Carries no organization (D-08). */
export type Authenticated = { user: AuthUser; session: AuthSession };

/**
 * Who is acting. Authentication answers only this; organizations, roles and
 * permissions are the tenancy module's (M3), resolved from the URL and checked
 * against membership.
 */
export type Actor =
  | { kind: "user"; userId: string; sessionId: string; emailVerified: boolean }
  | { kind: "anonymous" };

export const ANONYMOUS: Actor = { kind: "anonymous" };
