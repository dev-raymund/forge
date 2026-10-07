"use client";

import { useActionState } from "react";
import { FormAlert, SubmitButton } from "@/components/admin/form";
import { IDLE, type FormState } from "@/platform/forms";

/**
 * The one button on an invitation page for the person it was sent to. The
 * action arrives already bound to the invitation's token by the page (a server
 * component): this component never sees the token as a value of its own.
 */
export function AcceptInvitationForm({ action }: { action: (state: FormState, formData: FormData) => Promise<FormState> }) {
  const [state, submit, pending] = useActionState(action, IDLE);
  return (
    <form
      action={submit}
      onSubmit={(event) => {
        if (pending) event.preventDefault();
      }}
      className="grid gap-4"
      aria-label="Accept invitation"
    >
      {state.status === "error" && state.message ? <FormAlert tone="error">{state.message}</FormAlert> : null}
      <SubmitButton pending={pending} pendingLabel="Joining…">
        Accept invitation
      </SubmitButton>
    </form>
  );
}
