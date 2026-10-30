"use client";

import { Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IDLE } from "@/platform/forms";
import { trashEntryAction, unpublishEntryAction } from "../actions";
import { ENTRY_TRASH_DAYS } from "../lifecycle";
import type { EditorEntry } from "../queries";

/**
 * The editor's lifecycle actions (M7-1): Unpublish, beside Publish, and "Move to trash", under the entry's settings.
 * Each asks first and says what will happen; the server decides, and its refusal is shown as it is. A page goes to the
 * trash with every page below it: the dialog says how many, and why it cannot when a published page or the Home page
 * is among them.
 */

const messageOf = (state: { message?: string; fieldErrors?: Record<string, string[]> }, fallback: string) =>
  state.message ?? (state.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined) ?? fallback;

/**
 * Unpublish asks first. Those who manage the site's redirects may also send the address's visitors elsewhere ("redirect
 * this address to…", plan §9; M8-5): a published page of the site or an address elsewhere. Left empty, the address
 * answers "not found". A destination the server refuses is said in the dialog, and nothing is unpublished.
 */
export function UnpublishButton({
  orgSlug, siteSlug, entry, title, path, disabled, onDone,
}: {
  orgSlug: string;
  siteSlug: string;
  entry: EditorEntry;
  title: string;
  /** Its live address (`/about`): what visitors would be sent from. */
  path: string;
  disabled: boolean;
  onDone: (result: { ok: boolean; text: string }) => void;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [redirectTo, setRedirectTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const noun = entry.type === "page" ? "page" : "post";
  const offerRedirect = entry.lifecycle.canRedirect && path !== "/";
  async function unpublish() {
    setPending(true);
    setError(null);
    try {
      const data = new FormData();
      if (offerRedirect && redirectTo.trim()) data.set("redirectTo", redirectTo.trim());
      const state = await unpublishEntryAction(orgSlug, siteSlug, entry.id, IDLE, data);
      if (state.status !== "success" && state.fieldErrors?.redirectTo) return setError(state.fieldErrors.redirectTo[0] ?? "Choose another address.");
      onDone(state.status === "success" ? { ok: true, text: state.message ?? "Unpublished." } : { ok: false, text: messageOf(state, "Not unpublished.") });
      setOpen(false);
      setRedirectTo("");
    } catch {
      onDone({ ok: false, text: "Not unpublished: the connection failed. Try again." });
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Button type="button" variant="outline" className="h-9 px-3" disabled={disabled || pending} onClick={() => setOpen(true)}>
        Unpublish
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unpublish {title || "this " + noun}?</DialogTitle>
            <DialogDescription>
              It leaves the site at once: its address shows “not found”, it drops out of the blog and its archives, and links to it become plain text. Its
              text, history and date are kept: publish it again to bring it back.
            </DialogDescription>
          </DialogHeader>
          {offerRedirect ? (
            <div className="grid gap-1" data-testid="unpublish-redirect">
              <label htmlFor={fieldId} className="text-sm font-medium">
                Send visitors of {path} to (optional)
              </label>
              <input
                id={fieldId}
                value={redirectTo}
                onChange={(event) => setRedirectTo(event.target.value)}
                placeholder="/another-page or https://…"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
                aria-invalid={error ? true : undefined}
                aria-describedby={`${fieldId}-hint`}
                className="h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 aria-invalid:border-destructive md:text-sm"
              />
              <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
                A published page of this site, or a full address elsewhere: a permanent redirect, kept under SEO → Redirects. Empty: “not found”.
              </p>
              {error ? (
                <p className="text-sm font-medium text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10 px-4" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" className="h-10 px-4" onClick={unpublish} disabled={pending} aria-busy={pending || undefined}>
              {pending ? "Unpublishing…" : "Unpublish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function TrashSection({
  orgSlug, siteSlug, entry, title, isLive, isScheduled = false, isHome, beforeTrash, onTrashed,
}: {
  orgSlug: string;
  siteSlug: string;
  entry: EditorEntry;
  title: string;
  isLive: boolean;
  /** Scheduled (M7-2): its schedule is canceled first. */
  isScheduled?: boolean;
  isHome: boolean;
  /** Saves what is typed; false when it could not be saved (the trash then waits). */
  beforeTrash: () => Promise<string | null>;
  onTrashed: (trashPath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noun = entry.type === "page" ? "page" : "post";
  const { below, liveBelow, homeBelow } = entry.lifecycle;
  const blocker = isLive
    ? `It is published. Unpublish it first, then move it to the trash.`
    : isScheduled
      ? "It is scheduled. Cancel the schedule first, then move it to the trash."
      : isHome
      ? "This is the home page. Make another page the home page first."
      : homeBelow
        ? "The home page is below it. Make another page the home page first."
        : liveBelow.length
          ? `${liveBelow.length === 1 ? "A page" : `${liveBelow.length} pages`} below it ${liveBelow.length === 1 ? "is" : "are"} published (${liveBelow.slice(0, 3).join(", ")}${liveBelow.length > 3 ? ", …" : ""}). Unpublish ${liveBelow.length === 1 ? "it" : "them"} first.`
          : null;

  async function trash() {
    setPending(true);
    setError(null);
    try {
      const unsaved = await beforeTrash();
      if (unsaved) return setError(unsaved);
      const state = await trashEntryAction(orgSlug, siteSlug, entry.id, IDLE, new FormData());
      if (state.status === "success") return onTrashed(state.values?.trashPath ?? "");
      setError(messageOf(state, "Not moved to the trash."));
    } catch {
      setError("Not moved to the trash: the connection failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label="Trash" className="grid gap-2 rounded-xl border p-4" data-testid="trash-section">
      <p className="text-sm font-medium">Move to trash</p>
      {blocker ? (
        <p className="text-sm text-muted-foreground" data-testid="trash-blocked">
          {blocker}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {below ? `With the ${below} ${below === 1 ? "page" : "pages"} below it. ` : ""}It can be restored for {ENTRY_TRASH_DAYS} days, then it is deleted for good.
        </p>
      )}
      <Button type="button" variant="outline" className="h-9 justify-self-start px-3 text-destructive" disabled={Boolean(blocker)} onClick={() => setOpen(true)}>
        <Trash2 aria-hidden="true" className="size-4" />
        Move to trash…
      </Button>
      <Dialog open={open} onOpenChange={(next) => (setOpen(next), next ? undefined : setError(null))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move {title || "this " + noun} to the trash?</DialogTitle>
            <DialogDescription>
              {below === 1 ? "The 1 page below it goes with it, and comes back with it. " : below ? `The ${below} pages below it go with it, and come back with it. ` : ""}
              Its address becomes free for other pages and posts. It can be restored as a draft for {ENTRY_TRASH_DAYS} days; after that it is deleted
              for good, with its history.
            </DialogDescription>
          </DialogHeader>
          {error ? <FormAlert tone="error">{error}</FormAlert> : null}
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10 px-4" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" className="h-10 px-4" onClick={trash} disabled={pending} aria-busy={pending || undefined}>
              {pending ? "Moving…" : below ? `Move ${below + 1} pages to trash` : "Move to trash"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
