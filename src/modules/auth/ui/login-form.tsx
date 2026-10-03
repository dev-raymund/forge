"use client";

import { useEffect } from "react";
import type { LoginReason } from "@/platform/routing/admin-access";
import { signInAction } from "../actions";
import { signInSchema } from "../validation";
import { AuthLink } from "./auth-card";
import { Field, FormAlert, PasswordField, SubmitButton, useAuthForm } from "./form";

const NOTICES: Record<LoginReason, { tone: "info" | "success"; text: string }> = {
  session: { tone: "info", text: "Your session has ended. Log in again to continue." },
  "password-reset": { tone: "success", text: "Your password has been changed. Log in with your new password." },
  "signed-out": { tone: "info", text: "You have been logged out." },
};

/** `next` is already reduced to a path on this app by the page; the action checks it again. */
export function LoginForm({ next, reason }: { next: string; reason?: LoginReason }) {
  const { state, pending, fieldErrors, message, formProps } = useAuthForm(signInAction, signInSchema);
  const notice = reason ? NOTICES[reason] : undefined;

  // A session that ended during a client-side transition arrives here without a
  // page load, with the signed-in screens still mounted (hidden) in the tab.
  // Load the page once for real so nothing of them remains.
  useEffect(() => {
    if (reason !== "session") return;
    const [loaded] = performance.getEntriesByType("navigation");
    if (loaded && loaded.name !== window.location.href) window.location.reload();
  }, [reason]);

  return (
    <form {...formProps} className="grid gap-4" aria-label="Log in">
      {message ? <FormAlert tone="error">{message}</FormAlert> : notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
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
        defaultValue={state.values?.email ?? ""}
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
  );
}
