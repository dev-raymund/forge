"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { fieldErrorsFrom } from "@/platform/errors";
import { loginPath, safeNextPath } from "@/platform/routing/admin-access";
import { changePassword, updateProfile } from "./account.service";
import { accountFailure, applyAuthCookies, failureState, leaveFor } from "./action-support";
import {
  requestPasswordReset, resendVerificationEmail, resetPassword, signIn, signOut, signUp, startGoogleSignIn,
} from "./credentials.service";
import { AUTH_MESSAGES } from "./errors";
import { getCurrentAuth } from "./session";
import { revokeOtherSessions, revokeSession } from "./sessions.service";
import {
  changePasswordSchema, forgotPasswordSchema, profileSchema, resetPasswordSchema, signInSchema, signUpSchema, text, type FormState,
} from "./validation";

/**
 * The auth forms' Server Actions (M2-2): parse → service → cookies → leave.
 * Passwords and tokens are read here, handed to the service, and never echoed
 * back, logged or reported. Each one ends with a full page load (`leaveFor`).
 */

/** The hidden field the Turnstile widget adds to the sign-up form. */
const TURNSTILE_FIELD = "cf-turnstile-response";

export async function signUpAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const values = { name: text(formData.get("name")), email: text(formData.get("email")) };
  const parsed = signUpSchema.safeParse({ ...values, password: text(formData.get("password")) });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrorsFrom(parsed.error), values };
  try {
    const captchaToken = text(formData.get(TURNSTILE_FIELD)) || undefined;
    const { setCookies } = await signUp(parsed.data, { headers: await headers(), captchaToken });
    await applyAuthCookies(setCookies);
  } catch (error) {
    return failureState(error, values);
  }
  // Signed in, not yet verified: say so, instead of dropping the user into the app.
  return leaveFor("/verify-email");
}

export async function signInAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const values = { email: text(formData.get("email")) };
  const parsed = signInSchema.safeParse({ ...values, password: text(formData.get("password")) });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrorsFrom(parsed.error), values };
  try {
    const { setCookies } = await signIn(parsed.data, { headers: await headers() });
    await applyAuthCookies(setCookies);
  } catch (error) {
    return failureState(error, values);
  }
  // `next` comes from the URL, so it is untrusted: only a path on this app is followed.
  return leaveFor(safeNextPath(formData.get("next")));
}

/**
 * "Continue with Google" on the login and sign-up screens. Sets the cookie
 * that ties the flow to this browser and leaves for Google's authorization
 * page; Google comes back to `/api/auth/callback/google`.
 */
export async function signInWithGoogleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  let url: string;
  try {
    const started = await startGoogleSignIn({ next: text(formData.get("next")) }, { headers: await headers() });
    await applyAuthCookies(started.setCookies);
    url = started.url;
  } catch (error) {
    return failureState(error);
  }
  return leaveFor(url);
}

/** Deletes the session, clears the cookie, and leaves for the login page. Fine to call without a session. */
export async function signOutAction(): Promise<FormState> {
  const { setCookies } = await signOut({ headers: await headers() });
  await applyAuthCookies(setCookies);
  return leaveFor(loginPath({ reason: "signed-out" }));
}

export async function resendVerificationAction(): Promise<FormState> {
  const auth = await getCurrentAuth();
  if (!auth) return leaveFor(loginPath({ next: "/verify-email", reason: "session" }));
  let alreadyVerified: boolean;
  try {
    ({ alreadyVerified } = await resendVerificationEmail(auth.user, { headers: await headers() }));
  } catch (error) {
    return failureState(error);
  }
  if (alreadyVerified) return leaveFor("/verify-email"); // verified in another tab: show it
  return { status: "success", message: "We sent a new link. It can take a minute to arrive." };
}

export async function requestPasswordResetAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const values = { email: text(formData.get("email")) };
  const parsed = forgotPasswordSchema.safeParse(values);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrorsFrom(parsed.error), values };
  try {
    await requestPasswordReset(parsed.data, { headers: await headers() });
  } catch (error) {
    return failureState(error, values);
  }
  // The same answer whether or not the address has an account.
  return { status: "success", values: { email: parsed.data.email } };
}

export async function resetPasswordAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = resetPasswordSchema.safeParse({ token: text(formData.get("token")), password: text(formData.get("password")) });
  if (!parsed.success) {
    const { token, ...fieldErrors } = fieldErrorsFrom(parsed.error);
    return { status: "error", fieldErrors, ...(token ? { message: AUTH_MESSAGES.INVALID_LINK } : {}) };
  }
  try {
    await resetPassword(parsed.data, { headers: await headers() });
  } catch (error) {
    return failureState(error);
  }
  // Every session was revoked: the user signs in with the new password.
  return leaveFor(loginPath({ reason: "password-reset" }));
}

// ── The account page (M2-4) ─────────────────────────────────────────────────
// Each action identifies the user from the session cookie on the server. No
// user id is ever read from the form, and a session to end is named only by
// its opaque handle. `refresh()` re-renders the page with what is now true.

export async function updateProfileAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const values = { name: text(formData.get("name")) };
  const parsed = profileSchema.safeParse(values);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrorsFrom(parsed.error), values };
  try {
    const { setCookies } = await updateProfile(parsed.data, { headers: await headers() });
    await applyAuthCookies(setCookies);
  } catch (error) {
    return accountFailure(error, values);
  }
  refresh();
  return { status: "success", message: "Your name has been updated.", values: { name: parsed.data.name } };
}

export async function changePasswordAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = changePasswordSchema.safeParse({
    currentPassword: text(formData.get("currentPassword")),
    newPassword: text(formData.get("newPassword")),
  });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrorsFrom(parsed.error) };
  try {
    // Every session of the user is revoked; the cookies carry this browser's new one.
    const { setCookies } = await changePassword(parsed.data, { headers: await headers() });
    await applyAuthCookies(setCookies);
  } catch (error) {
    return accountFailure(error);
  }
  refresh();
  return { status: "success", message: "Your password has been changed. Your other sessions have been logged out." };
}

/** Emails the signed-in user a link to set a password (an account created with Google has none). */
export async function sendSetPasswordLinkAction(): Promise<FormState> {
  const auth = await getCurrentAuth();
  if (!auth) return leaveFor(loginPath({ next: "/account", reason: "session" }));
  try {
    await requestPasswordReset({ email: auth.user.email }, { headers: await headers() });
  } catch (error) {
    return accountFailure(error);
  }
  return { status: "success", message: "We sent a link to your email address. It works once and expires in 60 minutes." };
}

export async function revokeSessionAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    await revokeSession(text(formData.get("session")), { headers: await headers() });
  } catch (error) {
    return accountFailure(error);
  }
  refresh();
  return { status: "success", message: "That session has been logged out." };
}

export async function revokeOtherSessionsAction(): Promise<FormState> {
  let revoked: number;
  try {
    ({ revoked } = await revokeOtherSessions({ headers: await headers() }));
  } catch (error) {
    return accountFailure(error);
  }
  refresh();
  return {
    status: "success",
    message: revoked === 0 ? "There were no other sessions." : revoked === 1 ? "1 other session has been logged out." : `${revoked} other sessions have been logged out.`,
  };
}
