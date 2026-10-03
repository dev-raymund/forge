"use server";

import { headers } from "next/headers";
import { fieldErrorsFrom } from "@/platform/errors";
import { loginPath, safeNextPath } from "@/platform/routing/admin-access";
import { applyAuthCookies, failureState, leaveFor } from "./action-support";
import {
  requestPasswordReset, resendVerificationEmail, resetPassword, signIn, signOut, signUp,
} from "./credentials.service";
import { AUTH_MESSAGES } from "./errors";
import { getCurrentAuth } from "./session";
import {
  forgotPasswordSchema, resetPasswordSchema, signInSchema, signUpSchema, text, type FormState,
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
