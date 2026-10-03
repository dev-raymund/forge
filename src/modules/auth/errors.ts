import { isAPIError } from "better-auth/api";
import {
  type AppError, forbidden, rateLimited, unauthenticated, validationError,
} from "@/platform/errors";
import { MIN_PASSWORD_LENGTH } from "./shared";

/**
 * Better Auth error → Forge error, for the UI and actions that call the auth
 * API (M2-2). Messages are ours and deliberately unspecific where specifics
 * would leak: a wrong password and an unknown email are indistinguishable.
 * Anything unmapped returns null: treat it as unexpected (generic message,
 * reported), never show Better Auth's text.
 */
const INVALID_LINK = "This link is invalid or has expired. Request a new one.";

const BY_CODE: Record<string, () => AppError> = {
  INVALID_EMAIL_OR_PASSWORD: () => validationError({ _form: ["Email or password is incorrect."] }),
  INVALID_PASSWORD: () => validationError({ _form: ["Email or password is incorrect."] }),
  CREDENTIAL_ACCOUNT_NOT_FOUND: () => validationError({ _form: ["Email or password is incorrect."] }),
  USER_NOT_FOUND: () => validationError({ _form: ["Email or password is incorrect."] }),
  INVALID_EMAIL: () => validationError({ email: ["Enter a valid email address."] }),
  // Sign-up reveals that an address is registered; login before verification makes that unavoidable (ADR 0004).
  USER_ALREADY_EXISTS: () => validationError({ email: ["An account with this email already exists."] }),
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: () => validationError({ email: ["An account with this email already exists."] }),
  PASSWORD_TOO_SHORT: () => validationError({ password: [`Use at least ${MIN_PASSWORD_LENGTH} characters.`] }),
  PASSWORD_TOO_LONG: () => validationError({ password: ["This password is too long."] }),
  INVALID_TOKEN: () => validationError({ _form: [INVALID_LINK] }),
  TOKEN_EXPIRED: () => validationError({ _form: [INVALID_LINK] }),
  EMAIL_NOT_VERIFIED: () => forbidden("Verify your email address to continue."),
  SESSION_EXPIRED: unauthenticated,
  FAILED_TO_GET_SESSION: unauthenticated,
};

export function authErrorToAppError(error: unknown): AppError | null {
  if (!isAPIError(error)) return null;
  const code = (error.body as { code?: string } | undefined)?.code;
  const mapped = code ? BY_CODE[code] : undefined;
  if (mapped) return mapped();
  if (error.statusCode === 429) return rateLimited();
  if (error.statusCode === 401) return unauthenticated();
  return null;
}
