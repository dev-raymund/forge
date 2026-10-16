"use client";

import { CalendarClock } from "lucide-react";
import { useId, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IDLE, type FormState } from "@/platform/forms";
import { cancelScheduleAction, rescheduleEntryAction, scheduleEntryAction } from "../actions";
import { formatInZone, offsetLabel, toLocalInput } from "../zoned-time";

/**
 * Scheduling in the editor (M7-2): "Schedule…" beside Publish for a draft; for a scheduled entry, when it publishes
 * (in the site's time zone, named) with "Change time…" and "Cancel schedule". The time is typed as the site's wall
 * clock; the server reads the site's zone itself and checks the time again. What is scheduled is the draft as it is
 * when scheduling: the dialog says so, and the editor says it again while it waits.
 */

const messageOf = (state: FormState, fallback: string) => (state.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined) ?? state.message ?? fallback;

type Result = { ok: true; scheduledAt: string; text: string } | { ok: false; text: string };

/** When the dialog was opened (the time is read in a click, never while rendering), and what its field starts with. */
type Opened = { now: Date; initial: string };

function ScheduleDialog({
  opened, onClose, title, description, submitLabel, timeZone, onSubmit,
}: {
  opened: Opened | null;
  onClose: () => void;
  title: string;
  description: string;
  submitLabel: string;
  timeZone: string;
  onSubmit: (runAt: string) => Promise<Result>;
}) {
  return (
    <Dialog open={opened !== null} onOpenChange={(next) => !next && onClose()}>
      {opened ? (
        <ScheduleForm key={opened.now.getTime()} opened={opened} onClose={onClose} title={title} description={description} submitLabel={submitLabel} timeZone={timeZone} onSubmit={onSubmit} />
      ) : null}
    </Dialog>
  );
}

function ScheduleForm({
  opened, onClose, title, description, submitLabel, timeZone, onSubmit,
}: { opened: Opened; onClose: () => void; title: string; description: string; submitLabel: string; timeZone: string; onSubmit: (runAt: string) => Promise<Result> }) {
  const id = useId();
  const [value, setValue] = useState(opened.initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { now } = opened;
  return (
    <>
      <DialogContent className="sm:max-w-md" data-testid="schedule-dialog">
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            setError(null);
            try {
              const result = await onSubmit(value);
              if (result.ok) onClose();
              else setError(result.text);
            } finally {
              setPending(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor={id} className="text-sm font-medium">
              Date and time in {timeZone} ({offsetLabel(now, timeZone)})
            </label>
            <input
              id={id}
              type="datetime-local"
              required
              step={60}
              min={toLocalInput(new Date(now.getTime() + 120_000), timeZone)}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-hint`}
              className="h-10 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:ring-3 focus-visible:ring-foreground/25 md:text-sm"
            />
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              The site&rsquo;s time zone ({timeZone}), set in its settings: not this computer&rsquo;s.
            </p>
          </div>
          {error ? <FormAlert tone="error">{error}</FormAlert> : null}
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10 px-4" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className="h-10 px-4" disabled={pending} aria-busy={pending || undefined}>
              {pending ? "Saving…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </>
  );
}

/** "Schedule…" for a draft: saves what is typed first, then schedules that version. */
export function ScheduleButton({
  orgSlug, siteSlug, entryId, timeZone, disabled, beforeSchedule, onScheduled,
}: {
  orgSlug: string;
  siteSlug: string;
  entryId: string;
  timeZone: string;
  disabled: boolean;
  /** Saves what is typed; the version to schedule, or why it cannot be. */
  beforeSchedule: () => Promise<{ version: number } | { error: string }>;
  onScheduled: (scheduledAt: string, text: string) => void;
}) {
  const [opened, setOpened] = useState<Opened | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-9 px-3"
        disabled={disabled}
        onClick={() => {
          // Tomorrow at 9:00 where the site is: a starting point to change.
          const now = new Date();
          setOpened({ now, initial: `${toLocalInput(new Date(now.getTime() + 24 * 3_600_000), timeZone).slice(0, 10)}T09:00` });
        }}
      >
        <CalendarClock aria-hidden="true" className="size-4" />
        Schedule…
      </Button>
      <ScheduleDialog
        opened={opened}
        onClose={() => setOpened(null)}
        title="Schedule publishing"
        description="It is published at that time as it is now. Changes you make after scheduling stay in the draft: cancel and schedule again to include them."
        submitLabel="Schedule"
        timeZone={timeZone}
        onSubmit={async (runAt) => {
          const saved = await beforeSchedule();
          if ("error" in saved) return { ok: false, text: saved.error };
          const data = new FormData();
          data.set("runAt", runAt);
          data.set("version", String(saved.version));
          try {
            const state = await scheduleEntryAction(orgSlug, siteSlug, entryId, IDLE, data);
            if (state.status !== "success") return { ok: false, text: messageOf(state, "Not scheduled.") };
            const scheduledAt = state.values?.scheduledAt ?? "";
            onScheduled(scheduledAt, `Scheduled for ${formatInZone(new Date(scheduledAt), timeZone)}.`);
            return { ok: true, scheduledAt, text: "" };
          } catch {
            return { ok: false, text: "Not scheduled: the connection failed. Try again." };
          }
        }}
      />
    </>
  );
}

/** A scheduled entry: when it publishes, and changing or canceling that. */
export function ScheduledControls({
  orgSlug, siteSlug, entryId, timeZone, scheduledAt, canChange, onChanged, onCanceled, onError,
}: {
  orgSlug: string;
  siteSlug: string;
  entryId: string;
  timeZone: string;
  scheduledAt: string;
  canChange: boolean;
  onChanged: (scheduledAt: string, text: string) => void;
  onCanceled: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [pending, setPending] = useState(false);
  const at = new Date(scheduledAt);
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="scheduled-controls">
      <span className="text-sm" data-testid="scheduled-for">
        Publishes {formatInZone(at, timeZone)}
      </span>
      {canChange ? (
        <>
          <Button type="button" variant="outline" className="h-9 px-3" disabled={pending} onClick={() => setOpened({ now: new Date(), initial: toLocalInput(at, timeZone) })}>
            Change time…
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-9 px-3"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={async () => {
              setPending(true);
              try {
                const state = await cancelScheduleAction(orgSlug, siteSlug, entryId, IDLE, new FormData());
                if (state.status === "success") onCanceled(state.message ?? "The schedule is canceled.");
                else onError(messageOf(state, "The schedule was not canceled."));
              } catch {
                onError("The schedule was not canceled: the connection failed. Try again.");
              } finally {
                setPending(false);
              }
            }}
          >
            Cancel schedule
          </Button>
          <ScheduleDialog
            opened={opened}
            onClose={() => setOpened(null)}
            title="Change the time"
            description="The same version is published, at the new time."
            submitLabel="Change time"
            timeZone={timeZone}
            onSubmit={async (runAt) => {
              const data = new FormData();
              data.set("runAt", runAt);
              try {
                const state = await rescheduleEntryAction(orgSlug, siteSlug, entryId, IDLE, data);
                if (state.status !== "success") return { ok: false, text: messageOf(state, "The time was not changed.") };
                const next = state.values?.scheduledAt ?? scheduledAt;
                onChanged(next, `Now scheduled for ${formatInZone(new Date(next), timeZone)}.`);
                return { ok: true, scheduledAt: next, text: "" };
              } catch {
                return { ok: false, text: "The time was not changed: the connection failed. Try again." };
              }
            }}
          />
        </>
      ) : null}
    </span>
  );
}
