import { z } from "zod";

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

/** The account page (M2-4). The name is the only profile field a user can change in V1. */
export const profileSchema = z.object({ name });
export const changePasswordSchema = z.object({
  /** Being checked, not chosen: only "is there one". */
  currentPassword: z.string().min(1, "Enter your current password.").max(MAX_PASSWORD_LENGTH, "Your current password is incorrect."),
  newPassword,
});

export type ProfileInput = z.infer<typeof profileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

// The form state every admin form shares (platform/forms.ts); re-exported so the auth module's imports stay as they were.
export { IDLE, text } from "@/platform/forms";
export type { FormState } from "@/platform/forms";
