/**
 * Client-safe auth types and constants. Everything the rest of Forge knows
 * about a signed-in user comes from here; Better Auth's own types stay inside
 * modules/auth (D-07, lint-enforced).
 */

export {
  MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, IDLE,
  signUpSchema, signInSchema, forgotPasswordSchema, resetPasswordSchema, profileSchema, changePasswordSchema,
} from "./validation";
export type {
  FormState, SignUpInput, SignInInput, ForgotPasswordInput, ResetPasswordInput, ProfileInput, ChangePasswordInput,
} from "./validation";
export {
  SESSION_COOKIE, SECURE_SESSION_COOKIE, SESSION_IDLE_SECONDS, findSessionCookie, renewedSessionCookie,
} from "./cookie";
export type { SessionCookie } from "./cookie";

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
