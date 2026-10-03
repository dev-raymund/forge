"use client";

import { resetPasswordAction } from "../actions";
import { MIN_PASSWORD_LENGTH, resetPasswordSchema } from "../validation";
import { AuthLink } from "./auth-card";
import { FormAlert, PasswordField, SubmitButton, useAuthForm } from "./form";

/** The token travels in a hidden field: it is posted to the action and never kept in client state. */
export function ResetPasswordForm({ token }: { token: string }) {
  const { pending, fieldErrors, message, formProps } = useAuthForm(resetPasswordAction, resetPasswordSchema);
  return (
    <form {...formProps} className="grid gap-4" aria-label="Choose a new password">
      {message ? (
        <FormAlert tone="error">
          {message} <AuthLink href="/forgot-password">Request a new link</AuthLink>
        </FormAlert>
      ) : null}
      <input type="hidden" name="token" value={token} />
      <PasswordField
        name="password"
        label="New password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words work well.`}
        errors={fieldErrors.password}
      />
      <SubmitButton pending={pending} pendingLabel="Saving…">
        Change password
      </SubmitButton>
    </form>
  );
}

/** The link was used, has expired, or was never valid. One message for all three. */
export function ResetLinkInvalid() {
  return (
    <div className="grid gap-4" data-testid="reset-link-invalid">
      <FormAlert tone="error">This link is invalid or has expired.</FormAlert>
      <p className="text-sm text-muted-foreground">Reset links work once and expire after an hour.</p>
      <p className="text-sm">
        <AuthLink href="/forgot-password">Request a new link</AuthLink>
      </p>
    </div>
  );
}
