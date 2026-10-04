"use client";

import { LoaderCircle } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { signInWithGoogleAction } from "../actions";
import { IDLE } from "../validation";
import { FormAlert, useLeave } from "./form";

/** Google's "G", as its sign-in branding asks for it. Decorative: the button's text names it. */
function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className="size-4">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

/**
 * Starts a Google sign-in (the same flow signs a new person up). Rendered only
 * where Google is configured. `next` is where to land afterwards; the action
 * reduces it to a page of this app.
 */
export function GoogleButton({ next, label = "Continue with Google" }: { next: string; label?: string }) {
  const [state, action, running] = useActionState(signInWithGoogleAction, IDLE);
  useLeave(state);
  const pending = running || !!state.redirectTo;
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="grid gap-3"
      aria-label={label}
    >
      {state.status === "error" && state.message ? <FormAlert tone="error">{state.message}</FormAlert> : null}
      <input type="hidden" name="next" value={next} />
      <Button
        type="submit"
        variant="outline"
        aria-disabled={pending || undefined}
        aria-busy={pending || undefined}
        className="h-10 w-full focus-visible:border-foreground focus-visible:ring-foreground/25 aria-disabled:pointer-events-none aria-disabled:opacity-70"
      >
        {pending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <GoogleMark />}
        {pending ? "Opening Google…" : label}
      </Button>
    </form>
  );
}

/** "or" between the Google button and the email form. */
export function OrDivider() {
  return (
    <div role="separator" aria-orientation="horizontal" className="flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      or
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}
