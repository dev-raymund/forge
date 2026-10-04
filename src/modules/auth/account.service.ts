import "server-only";
import { eq } from "drizzle-orm";
import { identityDb } from "@/platform/db/identity";
import { validationError } from "@/platform/errors";
import { UnexpectedAuthError, type AuthCookies, type AuthRequest } from "./credentials.service";
import { authFailureToAppError } from "./errors";
import { callAuth } from "./gateway";
import { authAccounts } from "./schema";
import type { ChangePasswordInput, ProfileInput } from "./validation";

/**
 * What a signed-in user can do to their own account (M2-4): change the name,
 * change the password. Like the other use cases, these go through Better
 * Auth's request handler, which identifies the user from the session cookie:
 * no user id is ever taken from the caller.
 *
 * Not here, on purpose: the email address cannot be changed in V1
 * (`/change-email` is disabled), sign-in methods cannot be linked or unlinked,
 * and the avatar waits for the media pipeline (M6).
 */

/** How this account can sign in. Shown read-only. */
export type SignInMethods = { password: boolean; google: boolean };

export async function signInMethods(userId: string): Promise<SignInMethods> {
  const rows = await identityDb().select({ providerId: authAccounts.providerId }).from(authAccounts).where(eq(authAccounts.userId, userId));
  const providers = new Set(rows.map((row) => row.providerId));
  return { password: providers.has("credential"), google: providers.has("google") };
}

/** Changes the display name. Nothing else can be sent: the endpoint itself refuses other fields (./auth.ts). */
export async function updateProfile(input: ProfileInput, request: AuthRequest): Promise<AuthCookies> {
  const response = await callAuth("/update-user", request.headers, { name: input.name });
  if (response.status !== 200) throw authFailureToAppError(response) ?? new UnexpectedAuthError("update-user", response);
  return { setCookies: response.setCookies };
}

const WRONG_CURRENT = "Your current password is incorrect.";
const NO_PASSWORD = "This account has no password yet. Use the link below to set one.";

/**
 * Changes the password of the signed-in user after checking the current one.
 * Every session of the user is revoked, and this browser gets a new one (the
 * returned cookies), so a password change also ends whatever else was signed
 * in. The "password changed" notice is queued by Better Auth's hook.
 */
export async function changePassword(input: ChangePasswordInput, request: AuthRequest): Promise<AuthCookies> {
  const response = await callAuth("/change-password", request.headers, {
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
    revokeOtherSessions: true,
  });
  if (response.status === 200) return { setCookies: response.setCookies };
  // The login wording ("Email or password is incorrect") would be wrong here: say which field.
  if (response.code === "INVALID_PASSWORD") throw validationError({ currentPassword: [WRONG_CURRENT] });
  if (response.code === "CREDENTIAL_ACCOUNT_NOT_FOUND") throw validationError({ _form: [NO_PASSWORD] }, NO_PASSWORD);
  if (response.code === "PASSWORD_TOO_SHORT" || response.code === "PASSWORD_TOO_LONG") {
    const mapped = authFailureToAppError(response)!;
    throw validationError({ newPassword: mapped.fieldErrors?.password ?? [mapped.message] });
  }
  throw authFailureToAppError(response) ?? new UnexpectedAuthError("change-password", response);
}

export const ACCOUNT_MESSAGES = { WRONG_CURRENT, NO_PASSWORD } as const;
