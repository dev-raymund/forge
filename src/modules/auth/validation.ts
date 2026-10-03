import { z } from "zod";
import type { FieldErrors } from "@/platform/errors";

/**
 * The one definition of the auth forms' rules (M2-2). The browser uses these
 * for immediate feedback, the Server Actions use them as the authority, and
 * Better Auth is configured from the same password bounds.
 */

/** Plan §12. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter your email address.")
  .max(254, "Enter a valid email address.")
  .pipe(z.email("Enter a valid email address."));

/** A password being chosen: the full rules. Never trimmed: spaces are part of a passphrase. */
const newPassword = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, `Use at most ${MAX_PASSWORD_LENGTH} characters.`);

/** A password being checked: only "is there one", so the login form says nothing about the rules. */
const currentPassword = z.string().min(1, "Enter your password.").max(MAX_PASSWORD_LENGTH, "Email or password is incorrect.");

const name = z.string().trim().min(1, "Enter your name.").max(100, "Use at most 100 characters.");

export const signUpSchema = z.object({ name, email, password: newPassword });
export const signInSchema = z.object({ email, password: currentPassword });
export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({
  token: z.string().min(1, "This link is invalid or has expired. Request a new one.").max(512, "This link is invalid or has expired. Request a new one."),
  password: newPassword,
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * What a form action returns to `useActionState`. `values` echoes the
 * submitted non-secret fields so the form keeps them; passwords and tokens are
 * never echoed.
 */
export type FormState = {
  status: "idle" | "error" | "success";
  /** A message for the whole form (shown in the alert above the fields). */
  message?: string;
  /** Field name → messages. */
  fieldErrors?: FieldErrors;
  values?: Record<string, string>;
  /**
   * Where to go now, as a full page load. Signing in or out changes who the
   * page is for, so the browser leaves through a real navigation: nothing of
   * the previous state (rendered pages, typed passwords) is kept in the tab.
   */
  redirectTo?: string;
};

export const IDLE: FormState = { status: "idle" };

/** A FormData value as a string ("" for missing values and files). */
export const text = (value: FormDataEntryValue | null): string => (typeof value === "string" ? value : "");
