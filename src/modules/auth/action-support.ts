import "server-only";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAppError } from "@/platform/errors";
import { formFailure } from "@/platform/form-failure";
import { loginPath } from "@/platform/routing/admin-access";
import { requestIdFrom } from "@/platform/observability";
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

/** A thrown error → what the form shows (platform/form-failure.ts), reported under this module's name. */
export async function failureState(error: unknown, values: Record<string, string> = {}): Promise<FormState> {
  return formFailure(error, { module: "auth", requestId: requestIdFrom(await headers()), values });
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

/**
 * `failureState` for the account page. The one extra case: the session ended
 * (expired, or revoked from another browser) while the page was open. That is
 * not a form error to read and retry; the user leaves for the login page and
 * comes back to the account page afterwards.
 */
export async function accountFailure(error: unknown, values: Record<string, string> = {}): Promise<FormState> {
  if (isAppError(error) && error.kind === "Unauthenticated") return leaveFor(loginPath({ next: "/account", reason: "session" }));
  return failureState(error, values);
}
