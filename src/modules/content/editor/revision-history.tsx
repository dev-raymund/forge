"use client";

import { History } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { IDLE, type FormState } from "@/platform/forms";
import { previewLinkAction, restoreRevisionAction, revisionHistoryAction, saveRevisionAction } from "../actions";
import type { RevisionItem, RevisionList } from "../queries";
import { REVISION_KIND_WORDS, REVISION_LABEL_MAX } from "../revisions";
import { formatInZone } from "../zoned-time";
import { PreviewFrame } from "./preview-pane";

/**
 * The history (M7-3 criterion 2; plan §9 "Revisions"; cms-architecture §15): every revision of the entry, newest first,
 * with its number, its kind, who made it and when, its label, and which one visitors see ("Live") or a schedule will
 * publish ("Scheduled for …"). From here:
 *
 *   Save with a label   the draft as it is now, named ("Before the redesign")
 *   Preview             a revision as it was saved, drawn by the site's theme in a frame (M7-4), with "Restore this
 *                       revision…" beside it: looking changes nothing, restoring is a separate, confirmed step
 *   Restore             an earlier revision copied into the draft. Not the trash's restore (that brings an entry back):
 *                       nothing is published, and what the draft holds now is kept in the history first. The editor
 *                       then loads the draft again.
 *
 * Both save what is typed first (`beforeChange`), so nothing in the editor is lost or left behind. The server decides
 * who may and what is valid; the buttons only follow what it said (`canRestore`).
 */

const messageOf = (state: FormState, fallback: string) => (state.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined) ?? state.message ?? fallback;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

type Load = { state: "loading" } | { state: "ready"; list: RevisionList; older: boolean } | { state: "failed"; text: string };
type Ready = { version: number } | { error: string };

export function HistoryButton(props: {
  orgSlug: string;
  siteSlug: string;
  entryId: string;
  /** This editor can change the draft now (it may edit, holds blocks it knows, and is not in a conflict). */
  canChange: boolean;
  /** Saves what is typed: the draft version that is saved now, or why there is none. */
  beforeChange: () => Promise<Ready>;
  /** A revision was copied into the draft (the server's message): the editor loads the draft again. */
  onRestored: (text: string) => void;
  /** A labelled save went into the history. */
  onSaved: (text: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : setOpen(next))}>
      <Button type="button" variant="outline" className="h-9 px-3" onClick={() => setOpen(true)} disabled={props.disabled}>
        <History aria-hidden="true" />
        History
      </Button>
      {open ? <HistoryContent {...props} onBusy={setBusy} busy={busy} /> : null}
    </Dialog>
  );
}

function HistoryContent({
  orgSlug, siteSlug, entryId, canChange, beforeChange, onRestored, onSaved, busy, onBusy,
}: Parameters<typeof HistoryButton>[0] & { busy: boolean; onBusy: (busy: boolean) => void }) {
  const labelId = useId();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState<RevisionItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // M7-4: the revision being previewed, and its link once made.
  const [previewing, setPreviewing] = useState<{ revision: RevisionItem; path: string | null; error: string | null } | null>(null);

  const answerOf = (result: Awaited<ReturnType<typeof revisionHistoryAction>>): Load =>
    result.ok ? { state: "ready", list: result.data, older: false } : { state: "failed", text: result.error };
  useEffect(() => {
    let current = true;
    revisionHistoryAction(orgSlug, siteSlug, entryId).then(
      (result) => current && setLoad(answerOf(result)),
      () => current && setLoad({ state: "failed", text: "The connection failed." }),
    );
    return () => {
      current = false;
    };
  }, [orgSlug, siteSlug, entryId]);

  async function reload() {
    setLoad({ state: "loading" });
    try {
      setLoad(answerOf(await revisionHistoryAction(orgSlug, siteSlug, entryId)));
    } catch {
      setLoad({ state: "failed", text: "The connection failed." });
    }
  }

  async function showOlder() {
    if (load.state !== "ready") return;
    const before = load.list.items.at(-1)?.number;
    setLoad({ ...load, older: true });
    try {
      const result = await revisionHistoryAction(orgSlug, siteSlug, entryId, before);
      if (!result.ok) {
        setLoad({ ...load, older: false });
        return setError(result.error);
      }
      setLoad({ state: "ready", older: false, list: { ...result.data, items: [...load.list.items, ...result.data.items] } });
    } catch {
      setLoad({ ...load, older: false });
      setError("The older revisions could not be loaded: the connection failed. Try again.");
    }
  }

  /** Saves what is typed, then runs `work` with the version saved: one thing at a time. */
  async function withSavedDraft(work: (version: number) => Promise<void>) {
    if (busy) return;
    onBusy(true);
    setError(null);
    setNotice(null);
    try {
      const ready = await beforeChange();
      if ("error" in ready) return setError(ready.error);
      await work(ready.version);
    } catch {
      setError("The connection failed. Nothing was changed. Try again.");
    } finally {
      onBusy(false);
    }
  }

  const save = () =>
    withSavedDraft(async (version) => {
      const data = new FormData();
      data.set("version", String(version));
      data.set("label", label);
      const result = await saveRevisionAction(orgSlug, siteSlug, entryId, IDLE, data);
      if (result.status !== "success") return setError(messageOf(result, "Not saved to the history."));
      setLabel("");
      setNotice(result.message ?? "Saved.");
      onSaved(result.message ?? "Saved.");
      await reload();
    });

  const restore = (revision: RevisionItem) =>
    withSavedDraft(async (version) => {
      const data = new FormData();
      data.set("revisionId", revision.id);
      data.set("version", String(version));
      const result = await restoreRevisionAction(orgSlug, siteSlug, entryId, IDLE, data);
      if (result.status !== "success") return setError(messageOf(result, `Revision ${revision.number} was not restored.`));
      // Committed: the editor loads the draft as the server has it now.
      onRestored(result.message ?? `Revision ${revision.number} is in the draft now.`);
    });

  /** The revision's preview (M7-4): a link made for it (15 minutes), in a frame. Viewing it changes nothing. */
  async function preview(revision: RevisionItem) {
    setError(null);
    setNotice(null);
    setPreviewing({ revision, path: null, error: null });
    try {
      const result = await previewLinkAction(orgSlug, siteSlug, entryId, revision.id);
      setPreviewing({ revision, path: result.ok ? result.data.path : null, error: result.ok ? null : result.error });
    } catch {
      setPreviewing({ revision, path: null, error: "The preview could not be opened: the connection failed. Try again." });
    }
  }

  const hold = (event: Event) => busy && event.preventDefault();
  const restorable = canChange && load.state === "ready" && load.list.canRestore;
  const timeZone = load.state === "ready" ? load.list.timeZone : "UTC";
  return (
    <DialogContent className="max-h-[96dvh] overflow-y-auto sm:max-w-4xl" data-testid="history-dialog" onEscapeKeyDown={hold} onPointerDownOutside={hold} onInteractOutside={hold}>
      <DialogHeader>
        <DialogTitle>History</DialogTitle>
        <DialogDescription>
          Every saved, published, scheduled and restored version, newest first. Preview one to see it as it was saved. Restoring one copies it into the draft:
          nothing is published until you publish, and what the draft holds now is kept here first.
        </DialogDescription>
      </DialogHeader>

      {previewing ? (
        <section className="grid gap-3" aria-label={`Preview of revision ${previewing.revision.number}`} data-testid="revision-preview">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <RevisionMeta revision={previewing.revision} timeZone={timeZone} />
            <Button type="button" variant="outline" className="h-9 px-3" disabled={busy} onClick={() => setPreviewing(null)}>
              Back to the history
            </Button>
          </div>
          <p className="rounded-lg border border-amber-700/30 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="revision-preview-note">
            You are looking at revision {previewing.revision.number} as it was saved
            {previewing.revision.live ? ", which is what visitors see now" : previewing.revision.scheduledFor ? ", which the schedule publishes" : ""}. Viewing it changes
            nothing: it is not restored or published, and your draft is as you left it.
          </p>
          {error ? <FormAlert tone="error">{error}</FormAlert> : null}
          {previewing.error ? (
            <div className="grid justify-items-start gap-2">
              <FormAlert tone="error">{previewing.error}</FormAlert>
              <Button type="button" variant="outline" className="h-9 px-3" onClick={() => void preview(previewing.revision)}>
                Try again
              </Button>
            </div>
          ) : previewing.path ? (
            <PreviewFrame path={previewing.path} title={`Preview of revision ${previewing.revision.number}`} />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Opening the preview…
            </p>
          )}
          {restorable ? (
            confirm?.id === previewing.revision.id ? (
              <RestoreConfirm revision={previewing.revision} busy={busy} onCancel={() => setConfirm(null)} onRestore={() => void restore(previewing.revision)} />
            ) : (
              <Button type="button" className="h-10 w-fit px-4" disabled={busy} onClick={() => setConfirm(previewing.revision)}>
                Restore this revision…
              </Button>
            )
          ) : null}
        </section>
      ) : (
        <>
          {canChange ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <div className="grid min-w-0 flex-1 gap-1.5">
                <label htmlFor={labelId} className="text-sm font-medium">
                  Save the draft as it is now, with a label (optional)
                </label>
                <input
                  id={labelId}
                  value={label}
                  maxLength={REVISION_LABEL_MAX}
                  placeholder="Before the redesign"
                  onChange={(event) => setLabel(event.target.value)}
                  className="h-10 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:ring-3 focus-visible:ring-foreground/25 md:text-sm"
                />
              </div>
              <Button type="submit" variant="outline" className="h-10 px-4" disabled={busy} aria-busy={busy || undefined}>
                Save
              </Button>
            </form>
          ) : null}

          {notice ? <FormAlert tone="success">{notice}</FormAlert> : null}
          {error ? <FormAlert tone="error">{error}</FormAlert> : null}

          {load.state === "loading" ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading the history…
            </p>
          ) : load.state === "failed" ? (
            <div className="grid justify-items-start gap-2">
              <FormAlert tone="error">The history could not be loaded: {load.text}</FormAlert>
              <Button type="button" variant="outline" className="h-9 px-3" onClick={reload}>
                Try again
              </Button>
            </div>
          ) : load.list.items.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="no-revisions">
              Nothing in the history yet. Saving with a label, publishing and scheduling each add a revision.
            </p>
          ) : (
            <ol className="grid gap-2" aria-label="Revisions" data-testid="revision-list">
              {load.list.items.map((revision) => (
                <li
                  key={revision.id}
                  data-testid="revision"
                  data-number={revision.number}
                  className={cn("grid gap-2 rounded-lg border p-3", revision.live && "border-emerald-700/40")}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <RevisionMeta revision={revision} timeZone={timeZone} />
                    <span className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" className="h-9 px-3" disabled={busy} aria-label={`Preview revision ${revision.number}`} onClick={() => void preview(revision)}>
                        Preview
                      </Button>
                      {restorable && confirm?.id !== revision.id ? (
                        <Button type="button" variant="outline" className="h-9 px-3" disabled={busy} aria-label={`Restore revision ${revision.number}`} onClick={() => setConfirm(revision)}>
                          Restore…
                        </Button>
                      ) : null}
                    </span>
                  </div>
                  {confirm?.id === revision.id ? <RestoreConfirm revision={revision} busy={busy} onCancel={() => setConfirm(null)} onRestore={() => void restore(revision)} /> : null}
                </li>
              ))}
            </ol>
          )}
          {load.state === "ready" && load.list.more ? (
            <Button type="button" variant="outline" className="h-9 w-fit px-3" onClick={showOlder} disabled={load.older} aria-busy={load.older || undefined}>
              {load.older ? "Loading…" : "Show older revisions"}
            </Button>
          ) : null}
        </>
      )}
    </DialogContent>
  );
}

/** A revision as the history names it: number, kind, the Live and schedule markers, its label, title, who and when. */
function RevisionMeta({ revision, timeZone }: { revision: RevisionItem; timeZone: string }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
        <span>Revision {revision.number}</span>
        <span className="text-sm font-normal text-muted-foreground">{REVISION_KIND_WORDS[revision.kind]}</span>
        {revision.live ? (
          <span className="inline-flex h-5 items-center rounded-full border border-emerald-700/30 bg-emerald-50 px-2 text-xs font-medium text-emerald-900" data-testid="live-marker">
            Live
          </span>
        ) : null}
        {revision.scheduledFor ? (
          <span className="inline-flex h-5 items-center rounded-full border border-sky-700/30 bg-sky-50 px-2 text-xs font-medium text-sky-900" data-testid="scheduled-marker">
            Publishes {formatInZone(new Date(revision.scheduledFor), timeZone)}
          </span>
        ) : null}
      </p>
      {revision.label ? (
        <p className="text-sm wrap-anywhere" data-testid="revision-label">
          {revision.label}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground wrap-anywhere">
        {revision.title.trim() || "Untitled"} · {revision.byYou ? "You" : (revision.by ?? "A former member")} · {when(revision.createdAt)}
      </p>
    </div>
  );
}

/** The confirmation before a revision is copied into the draft (M7-3): what happens, and that nothing is published. */
function RestoreConfirm({ revision, busy, onCancel, onRestore }: { revision: RevisionItem; busy: boolean; onCancel: () => void; onRestore: () => void }) {
  return (
    <div className="grid gap-2 rounded-md bg-muted p-3" role="group" aria-label={`Restore revision ${revision.number}`} data-testid="restore-confirm">
      <p className="text-sm">
        Copy revision {revision.number} into the draft? What the draft holds now is kept in the history first. Nothing is published: visitors keep seeing the{" "}
        {revision.live ? "same" : "published"} version until you publish.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" className="h-9 px-3" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" className="h-9 px-3" disabled={busy} aria-busy={busy || undefined} onClick={onRestore}>
          {busy ? "Restoring…" : `Restore revision ${revision.number}`}
        </Button>
      </div>
    </div>
  );
}
