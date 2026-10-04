import "server-only";
import { AppError } from "@/platform/errors";
import { loginPath, safeNextPath } from "@/platform/routing/admin-access";
import { CAPTCHA_HEADER } from "./auth";
import { authFailureToAppError } from "./errors";
import { callAuth, type AuthResponse } from "./gateway";
import { isGoogleAuthorizeUrl } from "./oauth";
import type { AuthUser } from "./shared";
import type { ForgotPasswordInput, ResetPasswordInput, SignInInput, SignUpInput } from "./validation";

/**
 * The account use cases behind the auth forms (M2-2): sign up, sign in, sign
 * out, resend verification, request and complete a password reset.
 *
 * Each takes validated input and the caller's request headers, runs the
 * operation through Better Auth's request handler (./gateway.ts), and returns
 * the cookies to pass to the browser. Expected failures are thrown as
 * `AppError`s with Forge's messages; anything else is thrown as
 * `UnexpectedAuthError` (no Better Auth text) for the caller to report.
 */

/** Where the link in a verification email lands after Better Auth has checked it. */
export const VERIFY_EMAIL_CALLBACK = "/verify-email?status=verified";
/** Where the link in a reset email lands, with `?token=` or `?error=`. */
export const RESET_PASSWORD_PAGE = "/reset-password";

export type AuthRequest = {
  /** The headers of the request being served: the session cookie, the origin and the client address. */
  headers: Headers;
  /** The Turnstile token from the sign-up form, when Turnstile is configured. */
  captchaToken?: string;
};

export type AuthCookies = { setCookies: string[] };

export class UnexpectedAuthError extends Error {
  constructor(operation: string, response: AuthResponse) {
    super(`auth ${operation} failed unexpectedly: ${response.status}${response.code ? ` ${response.code}` : ""}`);
    this.name = "UnexpectedAuthError";
  }
}

function failure(operation: string, response: AuthResponse): AppError | UnexpectedAuthError {
  return authFailureToAppError(response) ?? new UnexpectedAuthError(operation, response);
}

/** Creates the account, signs the user in, and queues the verification email. */
export async function signUp(input: SignUpInput, request: AuthRequest): Promise<AuthCookies> {
  const response = await callAuth(
    "/sign-up/email",
    request.headers,
    { name: input.name, email: input.email, password: input.password, callbackURL: VERIFY_EMAIL_CALLBACK },
    request.captchaToken ? { [CAPTCHA_HEADER]: request.captchaToken } : {},
  );
  if (response.status !== 200) throw failure("sign-up", response);
  return { setCookies: response.setCookies };
}

/** A wrong password and an unknown address fail identically. */
export async function signIn(input: SignInInput, request: AuthRequest): Promise<AuthCookies> {
  const response = await callAuth("/sign-in/email", request.headers, { email: input.email, password: input.password });
  if (response.status !== 200) throw failure("sign-in", response);
  return { setCookies: response.setCookies };
}

/** Deletes the session row and returns the cookies that clear the browser's. Fine to call without a live session. */
export async function signOut(request: AuthRequest): Promise<AuthCookies> {
  const response = await callAuth("/sign-out", request.headers);
  if (response.status !== 200) throw failure("sign-out", response);
  return { setCookies: response.setCookies };
}

/**
 * Sends the verification email again to the signed-in user's own address (never
 * one supplied by the caller). Limited by Better Auth to 3 per minute per client.
 */
export async function resendVerificationEmail(user: AuthUser, request: AuthRequest): Promise<{ alreadyVerified: boolean }> {
  if (user.emailVerified) return { alreadyVerified: true };
  const response = await callAuth("/send-verification-email", request.headers, { email: user.email, callbackURL: VERIFY_EMAIL_CALLBACK });
  if (response.status === 200) return { alreadyVerified: false };
  if (response.code === "EMAIL_ALREADY_VERIFIED") return { alreadyVerified: true };
  throw failure("send-verification-email", response);
}

/**
 * Queues a reset email if the address has an account. Resolves the same way
 * when it does not: callers must not tell the two apart, and cannot.
 */
export async function requestPasswordReset(input: ForgotPasswordInput, request: AuthRequest): Promise<void> {
  const response = await callAuth("/request-password-reset", request.headers, { email: input.email, redirectTo: RESET_PASSWORD_PAGE });
  if (response.status !== 200) throw failure("request-password-reset", response);
}

/** Sets the new password with a single-use token. Every session of the user is revoked. */
export async function resetPassword(input: ResetPasswordInput, request: AuthRequest): Promise<void> {
  const response = await callAuth("/reset-password", request.headers, { token: input.token, newPassword: input.password });
  if (response.status !== 200) throw failure("reset-password", response);
}

/**
 * Starts a Google sign-in (or sign-up: the same flow). Returns Google's
 * authorization URL and the cookie that binds the flow to this browser.
 *
 * `next` is untrusted. Only a page of this app survives `safeNextPath`, and
 * Better Auth checks the URLs again against the app origin. The callback
 * (`/api/auth/callback/google`) finishes on `next`, or on the login page with
 * `?error=` when anything fails.
 */
export async function startGoogleSignIn(input: { next: string }, request: AuthRequest): Promise<AuthCookies & { url: string }> {
  const next = safeNextPath(input.next);
  const response = await callAuth("/sign-in/social", request.headers, {
    provider: "google",
    callbackURL: next,
    errorCallbackURL: loginPath({ next }),
    disableRedirect: true, // we navigate ourselves, after checking where to
  });
  if (response.status !== 200) throw failure("google sign-in", response);
  const url = response.body?.url;
  if (!isGoogleAuthorizeUrl(url)) throw new UnexpectedAuthError("google sign-in", response);
  return { url, setCookies: response.setCookies };
}
