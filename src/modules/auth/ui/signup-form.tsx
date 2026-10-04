"use client";

import { signUpAction } from "../actions";
import { MIN_PASSWORD_LENGTH, signUpSchema } from "../validation";
import { AuthLink } from "./auth-card";
import { Field, FormAlert, PasswordField, SubmitButton, useAuthForm } from "./form";
import { GoogleButton, OrDivider } from "./google-button";
import { TurnstileWidget } from "./turnstile-widget";

const EXISTS = "An account with this email already exists.";

type SignUpFormProps = {
  /** Set only where Turnstile is configured; without it there is no challenge. */
  turnstileSiteKey?: string;
  /** Shown only where Google sign-in is configured. Signing up with Google is the same flow as signing in. */
  googleEnabled?: boolean;
};

export function SignUpForm({ turnstileSiteKey, googleEnabled = false }: SignUpFormProps) {
  const { state, pending, fieldErrors, message, formProps } = useAuthForm(signUpAction, signUpSchema);
  const exists = fieldErrors.email?.[0] === EXISTS;
  return (
    <div className="grid gap-4">
      {googleEnabled ? (
        <>
          <GoogleButton next="/" label="Sign up with Google" />
          <OrDivider />
        </>
      ) : null}
      <form {...formProps} className="grid gap-4" aria-label="Sign up">
        {message ? <FormAlert tone="error">{message}</FormAlert> : null}
        {exists ? (
          <FormAlert tone="info">
            Already have an account? <AuthLink href="/login">Log in</AuthLink> or <AuthLink href="/forgot-password">reset your password</AuthLink>.
          </FormAlert>
        ) : null}
        <Field name="name" label="Name" autoComplete="name" required defaultValue={state.values?.name ?? ""} errors={fieldErrors.name} />
        <Field
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={state.values?.email ?? ""}
          errors={fieldErrors.email}
        />
        <PasswordField
          name="password"
          label="Password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words work well.`}
          errors={fieldErrors.password}
        />
        {/* A Turnstile token works once: every server response gets a fresh challenge. */}
        {turnstileSiteKey ? <TurnstileWidget siteKey={turnstileSiteKey} renewOn={state} /> : null}
        <SubmitButton pending={pending} pendingLabel="Creating account…">
          Create account
        </SubmitButton>
      </form>
    </div>
  );
}
