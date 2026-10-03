"use client";

import { useEffect, useRef } from "react";
import { requestPasswordResetAction } from "../actions";
import { forgotPasswordSchema } from "../validation";
import { AuthLink } from "./auth-card";
import { Field, FormAlert, SubmitButton, useAuthForm } from "./form";

export function ForgotPasswordForm({ resetMinutes }: { resetMinutes: number }) {
  const { state, pending, fieldErrors, message, formProps } = useAuthForm(requestPasswordResetAction, forgotPasswordSchema);
  const sent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status === "success") sent.current?.focus();
  }, [state]);

  if (state.status === "success") {
    // Identical for every address: it never says whether an account exists.
    return (
      <div ref={sent} tabIndex={-1} role="status" data-testid="reset-requested" className="grid gap-4 outline-none">
        <h2 className="text-base font-medium">Check your email</h2>
        <p className="text-sm text-muted-foreground">
          If an account exists for <strong className="font-medium wrap-anywhere text-foreground">{state.values?.email}</strong>, we sent a link to reset
          its password. The link works once and expires in {resetMinutes} minutes.
        </p>
        <p className="text-sm text-muted-foreground">
          Nothing in your inbox? Check the spelling and your spam folder, or <AuthLink href="/forgot-password">try again</AuthLink>.
        </p>
      </div>
    );
  }

  return (
    <form {...formProps} className="grid gap-4" aria-label="Reset your password">
      {message ? <FormAlert tone="error">{message}</FormAlert> : null}
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="username"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        defaultValue={state.values?.email ?? ""}
        errors={fieldErrors.email}
      />
      <SubmitButton pending={pending} pendingLabel="Sending…">
        Send reset link
      </SubmitButton>
    </form>
  );
}
