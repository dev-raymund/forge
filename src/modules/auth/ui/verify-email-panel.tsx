"use client";

import { MailCheck } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { resendVerificationAction, signOutAction } from "../actions";
import { IDLE } from "../validation";
import type { VerifyEmailView } from "../verify-email-view";
import { AuthLink } from "./auth-card";
import { FormAlert, SubmitButton, useLeave } from "./form";

const RESEND_WAIT_SECONDS = 60;

export function VerifyEmailPanel({ view }: { view: VerifyEmailView }) {
  switch (view.kind) {
    case "verified":
      return (
        <div className="grid gap-4" data-testid="verify-state" data-state="verified">
          <FormAlert tone="success">Your email address is verified.</FormAlert>
          <p className="text-sm">
            <AuthLink href="/">Continue to Forge</AuthLink>
          </p>
        </div>
      );
    case "confirmed":
      return (
        <div className="grid gap-4" data-testid="verify-state" data-state="confirmed">
          <FormAlert tone="success">Thanks, your email address is verified.</FormAlert>
          <p className="text-sm">
            <AuthLink href="/login">Log in to continue</AuthLink>
          </p>
        </div>
      );
    case "anonymous":
      return (
        <div className="grid gap-4" data-testid="verify-state" data-state="anonymous">
          <p className="text-sm text-muted-foreground">
            We send a verification link when you create an account. Log in to check your status or to get a new link.
          </p>
          <p className="text-sm">
            <AuthLink href="/login?next=%2Fverify-email">Log in</AuthLink>
          </p>
        </div>
      );
    case "invalid":
      return (
        <div className="grid gap-4" data-testid="verify-state" data-state="invalid">
          <FormAlert tone="error">This link is invalid or has expired.</FormAlert>
          {view.email ? (
            <>
              <p className="text-sm text-muted-foreground">
                Verification links expire after an hour. We can send a new one to{" "}
                <strong className="font-medium wrap-anywhere text-foreground">{view.email}</strong>.
              </p>
              <ResendButton label="Send a new link" />
            </>
          ) : (
            <p className="text-sm">
              <AuthLink href="/login?next=%2Fverify-email">Log in to get a new link</AuthLink>
            </p>
          )}
        </div>
      );
    case "pending":
      return (
        <div className="grid gap-4" data-testid="verify-state" data-state="pending">
          <div className="flex items-start gap-3">
            <MailCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              We sent a verification link to <strong className="font-medium wrap-anywhere text-foreground">{view.email}</strong>. Open it to verify your
              address. You can keep using Forge in the meantime; publishing a site and inviting people need a verified address.
            </p>
          </div>
          <ResendButton label="Resend email" />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
            <AuthLink href="/">Continue to Forge</AuthLink>
            <LogOutLink />
          </div>
        </div>
      );
  }
}

/**
 * Resends to the signed-in user's own address. The button waits a minute
 * between sends; the server enforces its own limit regardless.
 */
function ResendButton({ label }: { label: string }) {
  const [state, action, pending] = useActionState(resendVerificationAction, IDLE);
  useLeave(state);
  const [wait, setWait] = useState(0);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    if (state.status === "success" && !state.redirectTo) setWait(RESEND_WAIT_SECONDS);
  }
  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const waiting = wait > 0;
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (pending || waiting) event.preventDefault();
      }}
      className="grid gap-3"
    >
      {state.status === "success" && state.message ? <FormAlert tone="success">{state.message}</FormAlert> : null}
      {state.status === "error" ? <FormAlert tone="error">{state.message}</FormAlert> : null}
      <SubmitButton pending={pending} pendingLabel="Sending…" unavailable={waiting ? `You can resend in ${wait}s` : undefined}>
        {label}
      </SubmitButton>
    </form>
  );
}

function LogOutLink() {
  const [state, action] = useActionState(signOutAction, IDLE);
  useLeave(state);
  return (
    <form action={action}>
      <button
        type="submit"
        className="rounded-sm text-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-foreground/25"
      >
        Not you? Log out
      </button>
    </form>
  );
}
