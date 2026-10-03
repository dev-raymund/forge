import { isAPIError } from "better-auth/api";
import {
  type AppError, conflict, forbidden, rateLimited, unauthenticated, validationError,
} from "@/platform/errors";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./validation";

/**
 * Better Auth failure → Forge error, for the UI and the actions. Messages are
 * ours and deliberately unspecific where specifics would leak: a wrong password
 * and an unknown email are indistinguishable. Anything unmapped returns null:
 * treat it as unexpected (generic message, reported), never show Better Auth's text.
 */
const INVALID_LINK = "This link is invalid or has expired. Request a new one.";
const WRONG_CREDENTIALS = "Email or password is incorrect.";
const WRONG_ORIGIN = "This request didn't come from the Forge app. Reload the page and try again.";
const CAPTCHA = "Complete the security check and try again.";

export const AUTH_MESSAGES = { INVALID_LINK, WRONG_CREDENTIALS, WRONG_ORIGIN, CAPTCHA } as const;

const BY_CODE: Record<string, () => AppError> = {
  INVALID_EMAIL_OR_PASSWORD: () => validationError({ _form: [WRONG_CREDENTIALS] }, WRONG_CREDENTIALS),
  INVALID_PASSWORD: () => validationError({ _form: [WRONG_CREDENTIALS] }, WRONG_CREDENTIALS),
  CREDENTIAL_ACCOUNT_NOT_FOUND: () => validationError({ _form: [WRONG_CREDENTIALS] }, WRONG_CREDENTIALS),
  USER_NOT_FOUND: () => validationError({ _form: [WRONG_CREDENTIALS] }, WRONG_CREDENTIALS),
  INVALID_EMAIL: () => validationError({ email: ["Enter a valid email address."] }),
  // Sign-up reveals that an address is registered; login before verification makes that unavoidable (ADR 0004).
  USER_ALREADY_EXISTS: () => validationError({ email: ["An account with this email already exists."] }),
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: () => validationError({ email: ["An account with this email already exists."] }),
  PASSWORD_TOO_SHORT: () => validationError({ password: [`Use at least ${MIN_PASSWORD_LENGTH} characters.`] }),
  PASSWORD_TOO_LONG: () => validationError({ password: [`Use at most ${MAX_PASSWORD_LENGTH} characters.`] }),
  INVALID_TOKEN: () => validationError({ _form: [INVALID_LINK] }, INVALID_LINK),
  TOKEN_EXPIRED: () => validationError({ _form: [INVALID_LINK] }, INVALID_LINK),
  EMAIL_NOT_VERIFIED: () => forbidden("Verify your email address to continue."),
  EMAIL_ALREADY_VERIFIED: () => conflict("Your email address is already verified."),
  EMAIL_MISMATCH: () => forbidden(),
  SESSION_EXPIRED: unauthenticated,
  FAILED_TO_GET_SESSION: unauthenticated,
  // Origin and CSRF rejections (the app was opened from an address other than APP_ORIGIN, or a forged request).
  INVALID_ORIGIN: () => forbidden(WRONG_ORIGIN),
  MISSING_OR_NULL_ORIGIN: () => forbidden(WRONG_ORIGIN),
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: () => forbidden(WRONG_ORIGIN),
  INVALID_CALLBACK_URL: () => forbidden(WRONG_ORIGIN),
  INVALID_REDIRECT_URL: () => forbidden(WRONG_ORIGIN),
  INVALID_ERROR_CALLBACK_URL: () => forbidden(WRONG_ORIGIN),
  INVALID_NEW_USER_CALLBACK_URL: () => forbidden(WRONG_ORIGIN),
  // Turnstile (sign-up).
  MISSING_RESPONSE: () => validationError({ _form: [CAPTCHA] }, CAPTCHA),
  VERIFICATION_FAILED: () => validationError({ _form: [CAPTCHA] }, CAPTCHA),
};

export type AuthFailure = { status: number; code?: string; retryAfterSeconds?: number };

/** For responses of the auth handler (the forms, through `callAuth`). */
export function authFailureToAppError({ status, code, retryAfterSeconds }: AuthFailure): AppError | null {
  const mapped = code ? BY_CODE[code] : undefined;
  if (mapped) return mapped();
  if (status === 429) return rateLimited(retryAfterSeconds);
  if (status === 401) return unauthenticated();
  return null;
}

/** For errors thrown by `auth.api.*`. */
export function authErrorToAppError(error: unknown): AppError | null {
  if (!isAPIError(error)) return null;
  const code = (error.body as { code?: string } | undefined)?.code;
  return authFailureToAppError({ status: error.statusCode, code });
}
