"use client";

import { useEffect } from "react";
import type { LoginReason } from "@/platform/routing/admin-access";
import { signInAction } from "../actions";
import { signInSchema } from "../validation";
import { AuthLink } from "./auth-card";
import { Field, FormAlert, PasswordField, SubmitButton, useAuthForm } from "./form";
import { GoogleButton, OrDivider } from "./google-button";

const NOTICES: Record<LoginReason, { tone: "info" | "success"; text: string }> = {
  session: { tone: "info", text: "Your session has ended. Log in again to continue." },
  "password-reset": { tone: "success", text: "Your password has been changed. Log in with your new password." },
  "signed-out": { tone: "info", text: "You have been logged out." },
};

type LoginFormProps = {
  /** Already reduced to a path on this app by the page; the actions check it again. */
  next: string;
  reason?: LoginReason;
  /** Shown only where Google sign-in is configured. */
  googleEnabled?: boolean;
  /** Why a Google sign-in that just came back failed (our wording, never the URL's). */
  oauthError?: string;
  /** An address to start the form with (the one an invitation was sent to). A convenience only. */
  email?: string;
};

export function LoginForm({ next, reason, googleEnabled = false, oauthError, email = "" }: LoginFormProps) {
  const { state, pending, fieldErrors, message, formProps } = useAuthForm(signInAction, signInSchema);
  const notice = reason ? NOTICES[reason] : undefined;
  // The Google failure belongs to the page load that brought it: once the form has been used, it goes.
  const untouched = state.status === "idle" && Object.keys(fieldErrors).length === 0;
  const googleFailure = untouched ? oauthError : undefined;

  // A session that ended during a client-side transition arrives here without a
  // page load, with the signed-in screens still mounted (hidden) in the tab.
  // Load the page once for real so nothing of them remains.
  useEffect(() => {
    if (reason !== "session") return;
    const [loaded] = performance.getEntriesByType("navigation");
    if (loaded && loaded.name !== window.location.href) window.location.reload();
  }, [reason]);

  return (
    <div className="grid gap-4">
      {/* About the Google attempt, so above the Google button; one message at a time. */}
      {googleFailure ? <FormAlert tone="error">{googleFailure}</FormAlert> : null}
      {googleEnabled ? (
        <>
          <GoogleButton next={next} />
          <OrDivider />
        </>
      ) : null}
      <form {...formProps} className="grid gap-4" aria-label="Log in">
        {message ? <FormAlert tone="error">{message}</FormAlert> : notice && !googleFailure ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
        <input type="hidden" name="next" value={next} />
        <Field
          name="email"
          label="Email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={state.values?.email ?? email}
          errors={fieldErrors.email}
        />
        <PasswordField name="password" label="Password" autoComplete="current-password" required errors={fieldErrors.password} />
        {/* After the field in the tab order: Tab goes from the email straight to the password. */}
        <p className="-mt-1 text-right text-sm">
          <AuthLink href="/forgot-password" className="font-normal">
            Forgot password?
          </AuthLink>
        </p>
        <SubmitButton pending={pending} pendingLabel="Logging in…">
          Log in
        </SubmitButton>
      </form>
    </div>
  );
}
