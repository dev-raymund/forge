import "server-only";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { asAppError } from "@/platform/errors";
import { reportError, requestIdFrom } from "@/platform/observability";
import type { FormState } from "./validation";

/** Helpers for ./actions.ts (a "use server" file may export only actions). */

/** Passes Better Auth's `Set-Cookie` values on to the browser. Server Actions and route handlers only. */
export async function applyAuthCookies(setCookies: string[]): Promise<void> {
  if (!setCookies.length) return;
  const jar = await cookies();
  for (const header of setCookies) {
    for (const [name, attributes] of parseSetCookieHeader(header)) {
      if (name) jar.set(name, attributes.value, toCookieOptions(attributes) as Parameters<typeof jar.set>[2]);
    }
  }
}

/**
 * A thrown error → what the form shows. Expected failures carry Forge's own
 * message. Anything else is reported (log + Sentry, never the form's values)
 * and the user gets a generic message with the request id.
 */
export async function failureState(error: unknown, values: Record<string, string> = {}): Promise<FormState> {
  const appError = asAppError(error);
  if (!appError) {
    const requestId = requestIdFrom(await headers());
    reportError(error, { module: "auth", requestId });
    return { status: "error", message: `Something went wrong. Please try again. Reference: ${requestId}`, values };
  }
  const { _form, ...fieldErrors } = appError.fieldErrors ?? {};
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  return {
    status: "error",
    message: _form?.[0] ?? (hasFieldErrors ? undefined : appError.message),
    ...(hasFieldErrors ? { fieldErrors } : {}),
    values,
  };
}

/**
 * Ends an action that changed who is signed in. With JavaScript the form
 * receives the destination and loads it as a new document, which drops every
 * page the client router was keeping (Next keeps previous routes mounted, so a
 * soft redirect would leave the signed-in screens, or a typed password, in the
 * tab). Without JavaScript the browser follows an ordinary redirect, which is a
 * new document anyway.
 */
export async function leaveFor(path: string): Promise<FormState> {
  if (!(await headers()).has("next-action")) redirect(path);
  return { status: "success", redirectTo: path };
}
