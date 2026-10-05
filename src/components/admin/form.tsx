"use client";

import { CircleAlert, CircleCheck, Eye, EyeOff, Info, LoaderCircle } from "lucide-react";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { fieldErrorsFrom, type FieldErrors } from "@/platform/errors";
import { IDLE, type FormState } from "@/platform/forms";

/**
 * Building blocks of the admin's forms (M2-2; shared since M3-3, when the
 * organization screens became their second user). Accessibility (WCAG 2.2 AA):
 * every input has a visible label; errors are text with an icon, tied to
 * their field with `aria-describedby` and announced; after a failed submit
 * focus moves to the first invalid field, or to the form's alert.
 */

// The kit's focus ring is too faint against white (below 3:1); admin forms use the foreground colour.
const FOCUS = "focus-visible:border-foreground focus-visible:ring-foreground/25";
export const CONTROL = cn("h-10", FOCUS);

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/** The first invalid field, or the form's alert when the error belongs to no field. */
function focusProblem(form: HTMLFormElement | null) {
  const target = form?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? form?.querySelector<HTMLElement>("[data-form-alert]");
  target?.focus();
}

/**
 * Follows an action's `redirectTo` as a full page load, so nothing of the
 * previous session's screens (or a typed password) stays in the tab.
 */
export function useLeave(state: FormState) {
  useEffect(() => {
    if (state.redirectTo) window.location.assign(state.redirectTo);
  }, [state]);
}

/**
 * `useActionState` plus the shared Zod schema for immediate feedback. The
 * server validates again with the same schema and remains the authority; with
 * JavaScript off the form still posts to the action.
 */
export function useActionForm(action: Action, schema: z.ZodType) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const [clientErrors, setClientErrors] = useState<FieldErrors | null>(null);
  const [attempt, setAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (pending) return event.preventDefault();
    const parsed = schema.safeParse(Object.fromEntries(new FormData(event.currentTarget)));
    if (parsed.success) return setClientErrors(null);
    event.preventDefault();
    setClientErrors(fieldErrorsFrom(parsed.error));
    setAttempt((n) => n + 1);
  }

  // After a failed submit, take the user to the problem: once per browser-side
  // failure, and once per server response.
  useEffect(() => {
    if (attempt > 0) focusProblem(formRef.current);
  }, [attempt]);
  useEffect(() => {
    if (state.status === "error") focusProblem(formRef.current);
  }, [state]);

  useLeave(state);

  const fieldErrors = clientErrors ?? (state.status === "error" ? state.fieldErrors : undefined) ?? {};
  return {
    state,
    // Still busy between the action's answer and the browser leaving the page.
    pending: pending || !!state.redirectTo,
    fieldErrors,
    /** The form-level message of the last server response; hidden while browser-side errors are showing. */
    message: clientErrors ? undefined : state.message,
    formProps: { ref: formRef, action: formAction, onSubmit, noValidate: true } as const,
  };
}

const TONES = {
  error: { Icon: CircleAlert, className: "border-destructive/40 bg-destructive/5 text-destructive", role: "alert" },
  success: { Icon: CircleCheck, className: "border-emerald-700/30 bg-emerald-50 text-emerald-900", role: "status" },
  info: { Icon: Info, className: "border-border bg-muted text-foreground", role: "status" },
} as const;

/** A message for the whole form. Errors are announced immediately (`alert`); the rest politely (`status`). */
export function FormAlert({ tone, children, className }: { tone: keyof typeof TONES; children: React.ReactNode; className?: string }) {
  const { Icon, className: toneClass, role } = TONES[tone];
  return (
    <div
      role={role}
      tabIndex={-1}
      data-form-alert=""
      data-tone={tone}
      className={cn("flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-foreground/25", toneClass, className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-4">{children}</div>
    </div>
  );
}

type FieldProps = Omit<React.ComponentProps<"input">, "id"> & {
  name: string;
  label: string;
  /** Shown under the field and read with it, e.g. the password rule. */
  hint?: string;
  errors?: string[];
};

function describedBy(id: string, hint: string | undefined, error: string | undefined) {
  return [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
}

function FieldMessages({ id, hint, error }: { id: string; hint?: string; error?: string }) {
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-sm font-medium text-destructive">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </>
  );
}

export function Field({ name, label, hint, errors, className, ...input }: FieldProps) {
  const id = useId();
  const error = errors?.[0];
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(CONTROL, className)}
        {...input}
      />
      <FieldMessages id={id} hint={hint} error={error} />
    </div>
  );
}

/** A password input with a show/hide button. The value is never kept in React state. */
export function PasswordField({ name, label, hint, errors, className, ...input }: FieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const error = errors?.[0];
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          className={cn(CONTROL, "pr-11", className)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          {...input}
        />
        <button
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => setVisible((v) => !v)}
          className={cn(
            "absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3",
            "focus-visible:ring-foreground/25",
          )}
        >
          {visible ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
        </button>
      </div>
      <FieldMessages id={id} hint={hint} error={error} />
    </div>
  );
}

/**
 * Stays focusable while unavailable (`aria-disabled`, not `disabled`), so
 * keyboard users don't lose their place. `unavailable` is a reason other than
 * a running request, e.g. a wait before the next resend.
 */
export function SubmitButton({
  pending, pendingLabel, unavailable, children, className,
}: { pending: boolean; pendingLabel: string; unavailable?: string; children: React.ReactNode; className?: string }) {
  const blocked = pending || !!unavailable;
  return (
    <Button
      type="submit"
      aria-disabled={blocked || undefined}
      aria-busy={pending || undefined}
      className={cn("h-10 w-full focus-visible:ring-foreground/40 aria-disabled:pointer-events-none aria-disabled:opacity-70", className)}
    >
      {pending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : null}
      {pending ? pendingLabel : (unavailable ?? children)}
    </Button>
  );
}
