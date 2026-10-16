"use client";

import { useEffect, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { draftHeadAction } from "../actions";
import type { DraftHeadInfo } from "../queries";

/**
 * The editor's conflict dialog (M5-4; M7-3 adds plan §6.3's third choice). The draft was saved somewhere else since
 * this editor opened it, so what is typed here cannot be saved over it unseen. Three ways out:
 *
 *   Copy my changes           to the clipboard, to paste after loading the latest version
 *   Load the latest version   what this editor had not saved is given up
 *   Overwrite with mine…      the dialog first says whose version it is (who saved it, when); confirmed, that very
 *                             version is kept in the history as a revision, then the draft becomes what this editor
 *                             holds. A version saved after the dialog said so is never overwritten unseen: the server
 *                             refuses it, and the dialog shows the newer one to decide again.
 *
 * Success is shown only once the server has answered with the new version; any refusal leaves the editor (and its
 * local copy of what was typed) as it was.
 */

export type OverwriteResult = { ok: true } | { ok: false; changedAgain: boolean; text: string };

type Head = { state: "loading" } | { state: "known"; head: DraftHeadInfo } | { state: "unknown"; text: string };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "saved by Ana Reyes at …", "saved by you (in another tab or window) at …", "saved by a former member at …". */
export function savedBy(head: DraftHeadInfo): string {
  const who = head.byYou ? "you, in another tab or window," : (head.by ?? "a former member");
  return `saved by ${who} at ${when(head.savedAt)}`;
}

type ConflictProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  siteSlug: string;
  entryId: string;
  /** This editor holds something that can be written (it may edit the entry, and its document is one it can hold). */
  canOverwrite: boolean;
  copied: string | null;
  onCopy: () => void;
  onLoadLatest: () => void;
  /** Writes what the editor holds over the draft at `replaceVersion`, after that version is kept as a revision. */
  onOverwrite: (replaceVersion: number) => Promise<OverwriteResult>;
};

export function ConflictDialog({ open, onOpenChange, ...props }: ConflictProps) {
  // The content is made each time the dialog opens, so it asks the server who saved the draft every time.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <ConflictContent {...props} onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function ConflictContent({
  orgSlug, siteSlug, entryId, canOverwrite, copied, onCopy, onLoadLatest, onOverwrite, onClose,
}: Omit<ConflictProps, "open" | "onOpenChange"> & { onClose: () => void }) {
  const [head, setHead] = useState<Head>({ state: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answerOf = (result: Awaited<ReturnType<typeof draftHeadAction>>): Head => (result.ok ? { state: "known", head: result.data } : { state: "unknown", text: result.error });
  useEffect(() => {
    let current = true;
    draftHeadAction(orgSlug, siteSlug, entryId).then(
      (result) => current && setHead(answerOf(result)),
      () => current && setHead({ state: "unknown", text: "The connection failed." }),
    );
    return () => {
      current = false;
    };
  }, [orgSlug, siteSlug, entryId]);

  async function check() {
    setHead({ state: "loading" });
    try {
      setHead(answerOf(await draftHeadAction(orgSlug, siteSlug, entryId)));
    } catch {
      setHead({ state: "unknown", text: "The connection failed." });
    }
  }

  async function overwrite() {
    if (head.state !== "known" || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await onOverwrite(head.head.version);
      if (result.ok) return onClose();
      setError(result.text);
      // Saved again meanwhile: the dialog says by whom, and the person decides again.
      if (result.changedAgain) await check();
    } finally {
      setPending(false);
    }
  }

  // Not closed while an overwrite is on its way: its answer is shown here.
  const hold = (event: Event) => pending && event.preventDefault();
  return (
    <DialogContent className="sm:max-w-lg" data-testid="conflict-dialog" onEscapeKeyDown={hold} onPointerDownOutside={hold} onInteractOutside={hold}>
      <DialogHeader>
        <DialogTitle>This draft was changed somewhere else</DialogTitle>
        <DialogDescription>
          A newer version was saved in another tab or by someone else. Your latest changes have not been saved, and nothing you type now will be.
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm" role="status" aria-live="polite" data-testid="conflict-head">
        {head.state === "loading" ? "Checking who saved it…" : head.state === "known" ? `The newer version was ${savedBy(head.head)}.` : `Who saved it could not be checked: ${head.text}`}
      </p>
      {copied ? <FormAlert tone="success">{copied}</FormAlert> : null}
      {confirming && head.state === "known" ? (
        <div className="grid gap-3 rounded-lg border p-3" role="group" aria-labelledby="overwrite-heading" data-testid="overwrite-confirm">
          <p id="overwrite-heading" className="font-medium">
            Overwrite the draft with your version?
          </p>
          <p className="text-sm text-muted-foreground">
            The version {savedBy(head.head)} is kept in the history first, so it can be restored. Then the draft becomes what you see here: the title, the text and
            the settings. Nothing is published: visitors see the published version until someone publishes.
          </p>
          {error ? <FormAlert tone="error">{error}</FormAlert> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" className="h-10 px-4" disabled={pending} onClick={() => setConfirming(false)}>
              Back
            </Button>
            <Button type="button" variant="destructive" className="h-10 px-4" disabled={pending} aria-busy={pending || undefined} onClick={overwrite}>
              {pending ? "Overwriting…" : "Overwrite"}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {head.state === "unknown" ? (
            <Button type="button" variant="outline" className="h-9 w-fit px-3" onClick={check}>
              Check again
            </Button>
          ) : null}
          <DialogFooter className="flex-wrap">
            <Button type="button" variant="outline" className="h-10 px-4" onClick={onCopy}>
              Copy my changes
            </Button>
            {canOverwrite ? (
              <Button type="button" variant="outline" className="h-10 px-4" disabled={head.state !== "known"} onClick={() => setConfirming(true)}>
                Overwrite with my version…
              </Button>
            ) : null}
            <Button type="button" className="h-10 px-4" onClick={onLoadLatest}>
              Load the latest version
            </Button>
          </DialogFooter>
        </>
      )}
    </DialogContent>
  );
}
