"use client";

import { useActionState, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { changePasswordAction, revokeOtherSessionsAction, revokeSessionAction, sendSetPasswordLinkAction, updateProfileAction } from "../actions";
import { changePasswordSchema, IDLE, MIN_PASSWORD_LENGTH, profileSchema, type FormState } from "../validation";
import { Field, FormAlert, PasswordField, SubmitButton, useAuthForm, useLeave } from "./form";

/** The outcome of an account action: errors at once (`alert`), confirmations politely (`status`). */
function Outcome({ state, message }: { state: FormState; message: string | undefined }) {
  if (!message || state.redirectTo) return null;
  return <FormAlert tone={state.status === "error" ? "error" : "success"}>{message}</FormAlert>;
}

/** The display name: the one profile field a user can change in V1. */
export function ProfileForm({ name }: { name: string }) {
  const { state, pending, fieldErrors, message, formProps } = useAuthForm(updateProfileAction, profileSchema);
  return (
    <form {...formProps} className="grid max-w-sm gap-4" aria-label="Profile">
      <Outcome state={state} message={message} />
      <Field name="name" label="Name" autoComplete="name" required defaultValue={state.values?.name ?? name} errors={fieldErrors.name} />
      <SubmitButton pending={pending} pendingLabel="Saving…" className="w-auto justify-self-start px-4">
        Save name
      </SubmitButton>
    </form>
  );
}

/** Needs the current password. A successful change logs out every other session. */
export function ChangePasswordForm({ email }: { email: string }) {
  const { state, pending, fieldErrors, message, formProps } = useAuthForm(changePasswordAction, changePasswordSchema);
  return (
    <form {...formProps} className="grid max-w-sm gap-4" aria-label="Change password">
      <Outcome state={state} message={message} />
      {/* Lets a password manager file the new password under the right account. Never read by the server. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <PasswordField name="currentPassword" label="Current password" autoComplete="current-password" required errors={fieldErrors.currentPassword} />
      <PasswordField
        name="newPassword"
        label="New password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words work well.`}
        errors={fieldErrors.newPassword}
      />
      <p className="text-sm text-muted-foreground">Changing your password logs out your other sessions.</p>
      <SubmitButton pending={pending} pendingLabel="Changing…" className="w-auto justify-self-start px-4">
        Change password
      </SubmitButton>
    </form>
  );
}

/** For an account that signs in with Google and has no password: a link by email, like a reset. */
export function SetPasswordPrompt() {
  const [state, action, pending] = useActionState(sendSetPasswordLinkAction, IDLE);
  useLeave(state);
  return (
    <form action={action} className="grid max-w-sm gap-4" aria-label="Set a password">
      <Outcome state={state} message={state.message} />
      <p className="text-sm text-muted-foreground">
        This account signs in with Google and has no password. To add one, we will email you a link to choose it.
      </p>
      <SubmitButton pending={pending} pendingLabel="Sending…" className="w-auto justify-self-start px-4">
        Email me a link
      </SubmitButton>
    </form>
  );
}

/** What the session list shows. Nothing here identifies a session inside Forge: `handle` is opaque. */
export type SessionRow = {
  handle: string;
  current: boolean;
  device: string;
  ipAddress: string | null;
  /** ISO timestamps; shown as a day in the viewer's own time zone. */
  signedInAt: string;
  lastActiveAt: string;
};

const formatDay = (iso: string, timeZone?: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone }).format(new Date(iso));
const noSubscription = () => () => {};

/**
 * A day, in the viewer's time zone. The server does not know that zone, so it
 * renders the UTC day and the browser corrects it after hydration (a login at
 * 01:00 in Manila is still "yesterday" in UTC).
 */
function useLocalDay(iso: string): string {
  return useSyncExternalStore(noSubscription, () => formatDay(iso), () => formatDay(iso, "UTC"));
}

function Day({ iso }: { iso: string }) {
  return <time dateTime={iso}>{useLocalDay(iso)}</time>;
}

function RevokeButton({ session, busy }: { session: SessionRow; busy: boolean }) {
  const signedIn = useLocalDay(session.signedInAt);
  return (
    <Button
      type="submit"
      variant="outline"
      name="session"
      value={session.handle}
      aria-disabled={busy || undefined}
      // Several rows can say "Log out": the name tells them apart.
      aria-label={`Log out the session on ${session.device}, signed in ${signedIn}`}
      className={QUIET_BUTTON}
    >
      Log out
    </Button>
  );
}

const QUIET_BUTTON = "h-9 focus-visible:border-foreground focus-visible:ring-foreground/25 aria-disabled:pointer-events-none aria-disabled:opacity-70";

export function SessionList({ sessions }: { sessions: SessionRow[] }) {
  const [one, revokeOne, endingOne] = useActionState(revokeSessionAction, IDLE);
  const [others, revokeOthers, endingOthers] = useActionState(revokeOtherSessionsAction, IDLE);
  useLeave(one);
  useLeave(others);
  const busy = endingOne || endingOthers;
  const hasOthers = sessions.some((session) => !session.current);
  // Show the outcome of whichever action answered last.
  const [seen, setSeen] = useState<{ one: FormState; others: FormState; latest: FormState | null }>({ one, others, latest: null });
  if (seen.one !== one) setSeen({ one, others, latest: one });
  else if (seen.others !== others) setSeen({ one, others, latest: others });
  const latest = seen.latest;

  return (
    <div className="grid gap-4">
      {latest ? <Outcome state={latest} message={latest.message} /> : null}
      {/* One form for the list: the button that was pressed names the session, by its opaque handle. */}
      <form
        action={revokeOne}
        onSubmit={(event) => {
          if (busy) event.preventDefault();
        }}
        aria-label="Active sessions"
      >
        <ul className="divide-y rounded-lg border">
          {sessions.map((session) => (
            <li key={session.handle} data-testid="session" data-current={session.current} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>{session.device}</span>
                  {session.current ? <span className="rounded-full border px-2 py-0.5 text-xs font-normal">This device</span> : null}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Signed in <Day iso={session.signedInAt} /> · Last active <Day iso={session.lastActiveAt} />
                  {session.ipAddress ? <> · IP address {session.ipAddress}</> : null}
                </p>
              </div>
              {session.current ? null : <RevokeButton session={session} busy={busy} />}
            </li>
          ))}
        </ul>
      </form>
      {hasOthers ? (
        <form
          action={revokeOthers}
          onSubmit={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <Button type="submit" variant="outline" aria-disabled={busy || undefined} aria-busy={endingOthers || undefined} className={cn(QUIET_BUTTON, "px-4")}>
            {endingOthers ? "Logging out…" : "Log out all other sessions"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">This is your only active session.</p>
      )}
    </div>
  );
}
