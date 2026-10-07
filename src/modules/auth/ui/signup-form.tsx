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
  /** Where to continue afterwards (an invitation). Already reduced to a path on this app by the page; the action checks it again. */
  next?: string;
  /** An address to start the form with (the one an invitation was sent to). A convenience only: nothing trusts it. */
  email?: string;
};

export function SignUpForm({ turnstileSiteKey, googleEnabled = false, next = "/", email = "" }: SignUpFormProps) {
  const { state, pending, fieldErrors, message, formProps } = useAuthForm(signUpAction, signUpSchema);
  const exists = fieldErrors.email?.[0] === EXISTS;
  // Someone on their way to an invitation who already has an account keeps their destination.
  const loginHref = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
  return (
    <div className="grid gap-4">
      {googleEnabled ? (
        <>
          <GoogleButton next={next} label="Sign up with Google" />
          <OrDivider />
        </>
      ) : null}
      <form {...formProps} className="grid gap-4" aria-label="Sign up">
        {message ? <FormAlert tone="error">{message}</FormAlert> : null}
        {exists ? (
          <FormAlert tone="info">
            Already have an account? <AuthLink href={loginHref}>Log in</AuthLink> or <AuthLink href="/forgot-password">reset your password</AuthLink>.
          </FormAlert>
        ) : null}
        <input type="hidden" name="next" value={next} />
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
          defaultValue={state.values?.email ?? email}
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
