"use client";

import { Copy, ExternalLink, FileText, RotateCcw, Trash2 } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/modules/billing/shared";
import { IDLE, type FormState } from "@/platform/forms";
import { moveMediaAction, restoreMediaAction, trashMediaAction, updateMediaAction } from "../actions";
import type { LibraryFolderView, LibraryItemView } from "./media-library";

/**
 * One file of the library (M6-3, plan §19 "detail drawer"): a larger view (an image's variant, never its original),
 * what it is, its title, alternative text and caption, its folder, the URL to copy, and the trash. Those who may not
 * change it (an Author, for someone else's upload) see it without the controls; the server refuses them anyway.
 */

const MEDIA_TITLE_MAX = 200;
const MEDIA_ALT_MAX = 500;
const MEDIA_CAPTION_MAX = 1000;
const FIELD = "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none focus-visible:ring-3 focus-visible:ring-foreground/25 disabled:opacity-70 md:text-sm";
const messageOf = (state: FormState, fallback: string) => (state.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined) ?? state.message ?? fallback;

export function MediaDrawer({
  orgSlug, siteSlug, item, folders, onClose, onDone,
}: { orgSlug: string; siteSlug: string; item: LibraryItemView; folders: LibraryFolderView[]; onClose: () => void; onDone: (text: string) => void }) {
  const ids = { title: useId(), alt: useId(), caption: useId(), folder: useId() };
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const trashed = !!item.deletedAt;
  const editable = item.canEdit && !trashed;
  const name = item.title || item.filename;

  const run = (work: () => Promise<FormState>, fallback: string, close = false) =>
    startTransition(async () => {
      setError(null);
      const state = await work();
      if (state.status === "error") return setError(messageOf(state, fallback));
      onDone(state.message ?? "Done.");
      if (close) onClose();
    });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" data-testid="media-drawer">
        <DialogHeader>
          <DialogTitle className="wrap-anywhere">{name}</DialogTitle>
          <DialogDescription>
            {item.kind === "image" ? `Image${item.width && item.height ? `, ${item.width} × ${item.height}` : ""}` : "PDF"} · {formatBytes(item.storedBytes)} stored · uploaded by{" "}
            {item.uploadedBy} on {new Date(item.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
            {trashed ? " · in the trash" : ""}
          </DialogDescription>
        </DialogHeader>

        {error ? <FormAlert tone="error">{error}</FormAlert> : null}

        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="grid content-start gap-2">
            {item.kind === "image" && item.previewUrl && !trashed ? (
              // eslint-disable-next-line @next/next/no-img-element -- a variant from /media, sized already
              <img src={item.previewUrl} alt={item.altText} className="w-full rounded-lg border bg-muted object-contain" data-testid="media-preview" />
            ) : (
              <span className="flex aspect-square w-full items-center justify-center rounded-lg border bg-muted">
                <FileText aria-hidden="true" className="size-12" />
              </span>
            )}
            <p className="text-xs text-muted-foreground wrap-anywhere">File: {item.filename}</p>
            {!trashed ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 px-3"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(item.url);
                      setCopied(true);
                    } catch {
                      setError("The URL could not be copied. Select it below instead.");
                    }
                  }}
                >
                  <Copy aria-hidden="true" className="size-4" />
                  {copied ? "Copied" : "Copy URL"}
                </Button>
                <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-foreground/25">
                  <ExternalLink aria-hidden="true" className="size-4" />
                  Open
                </a>
              </div>
            ) : null}
            {!trashed ? (
              <input readOnly value={item.url} aria-label="URL" className={`${FIELD} text-xs`} data-testid="media-url" onFocus={(event) => event.currentTarget.select()} />
            ) : null}
          </div>

          <div className="grid content-start gap-4">
            {!item.canEdit ? <p className="text-sm text-muted-foreground">Only its uploader or an editor can change this file.</p> : null}
            <form
              className="grid gap-3"
              aria-label="Details"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                run(() => updateMediaAction(orgSlug, siteSlug, item.id, IDLE, data), "The details could not be saved.");
              }}
            >
              <div className="grid gap-1">
                <label htmlFor={ids.title} className="text-sm font-medium">
                  Title
                </label>
                <input id={ids.title} name="title" defaultValue={item.title} maxLength={MEDIA_TITLE_MAX} disabled={!editable} className={`${FIELD} h-10`} />
              </div>
              {item.kind === "image" ? (
                <div className="grid gap-1">
                  <label htmlFor={ids.alt} className="text-sm font-medium">
                    Alternative text
                  </label>
                  <textarea id={ids.alt} name="altText" defaultValue={item.altText} maxLength={MEDIA_ALT_MAX} rows={2} disabled={!editable} className={FIELD} aria-describedby={`${ids.alt}-hint`} />
                  <p id={`${ids.alt}-hint`} className="text-xs text-muted-foreground">
                    What the image shows, for people who cannot see it.
                  </p>
                </div>
              ) : null}
              <div className="grid gap-1">
                <label htmlFor={ids.caption} className="text-sm font-medium">
                  Caption
                </label>
                <textarea id={ids.caption} name="caption" defaultValue={item.caption} maxLength={MEDIA_CAPTION_MAX} rows={2} disabled={!editable} className={FIELD} />
              </div>
              {editable ? (
                <Button type="submit" className="h-10 justify-self-start px-4" disabled={pending} aria-busy={pending || undefined}>
                  Save details
                </Button>
              ) : null}
            </form>

            {editable ? (
              <form
                className="grid gap-1"
                aria-label="Move to a folder"
                onSubmit={(event) => {
                  event.preventDefault();
                  const target = String(new FormData(event.currentTarget).get("folderId") ?? "");
                  run(() => moveMediaAction(orgSlug, siteSlug, [item.id], target || null), "The file could not be moved.");
                }}
              >
                <label htmlFor={ids.folder} className="text-sm font-medium">
                  Folder
                </label>
                <div className="flex flex-wrap gap-2">
                  <select id={ids.folder} name="folderId" defaultValue={item.folderId ?? ""} className={`${FIELD} h-10 w-auto`}>
                    <option value="">No folder</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <Button type="submit" variant="outline" className="h-10 px-4" disabled={pending}>
                    Move
                  </Button>
                </div>
              </form>
            ) : null}

            {item.canTrash ? (
              trashed ? (
                <Button type="button" variant="outline" className="h-10 justify-self-start px-4" disabled={pending} onClick={() => run(() => restoreMediaAction(orgSlug, siteSlug, item.id), "The file could not be restored.", true)}>
                  <RotateCcw aria-hidden="true" className="size-4" />
                  Restore
                </Button>
              ) : (
                <div className="grid gap-1 border-t pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 justify-self-start px-4 text-destructive"
                    disabled={pending}
                    onClick={() => run(() => trashMediaAction(orgSlug, siteSlug, item.id), "The file could not be trashed.", true)}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                    Move to trash
                  </Button>
                  <p className="text-xs text-muted-foreground">Pages that show it stop showing it at once. It can be restored for 30 days.</p>
                </div>
              )
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
