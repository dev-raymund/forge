"use client";

import { Copy, Download, ExternalLink, FileText, RotateCcw, Trash2 } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/modules/billing/shared";
import { IDLE, type FormState } from "@/platform/forms";
import { mediaUsageAction, moveMediaAction, restoreMediaAction, trashMediaAction, updateMediaAction } from "../actions";
import type { MediaUsage } from "../library.service";
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
  // The trash asks first (M7-1): where the file is used, loaded when "Move to trash" is pressed.
  const [confirming, setConfirming] = useState<{ status: "loading" } | { status: "ready"; usage: MediaUsage } | { status: "unknown" } | null>(null);
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
                {item.kind === "document" ? (
                  // A browser may not show a PDF served sandboxed (ADR 0021) in its own viewer: the file itself, always (ADR 0023).
                  <a href={item.url} download={item.filename} className="inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-foreground/25">
                    <Download aria-hidden="true" className="size-4" />
                    Download
                  </a>
                ) : null}
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
                <div className="grid gap-2 border-t pt-4">
                  {confirming ? (
                    <div className="grid gap-2 rounded-lg border border-destructive/40 p-3" data-testid="trash-confirm" role="group" aria-label="Move to trash">
                      {confirming.status === "loading" ? (
                        <p role="status" className="text-sm text-muted-foreground">
                          Checking where it is used…
                        </p>
                      ) : (
                        <UsageWarning usage={confirming.status === "ready" ? confirming.usage : null} />
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          className="h-10 px-4"
                          disabled={pending || confirming.status === "loading"}
                          onClick={() => run(() => trashMediaAction(orgSlug, siteSlug, item.id), "The file could not be trashed.", true)}
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                          Move to trash
                        </Button>
                        <Button type="button" variant="outline" className="h-10 px-4" onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 justify-self-start px-4 text-destructive"
                      disabled={pending}
                      onClick={async () => {
                        setConfirming({ status: "loading" });
                        try {
                          const result = await mediaUsageAction(orgSlug, siteSlug, item.id);
                          setConfirming(result.ok ? { status: "ready", usage: result.data } : { status: "unknown" });
                        } catch {
                          setConfirming({ status: "unknown" });
                        }
                      }}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                      Move to trash…
                    </Button>
                  )}
                </div>
              )
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What moving a file to the trash does to the site (M7-1): the published pages and posts that stop showing it at once,
 * the drafts that hold it, the logo and favicon. Nothing here refuses the trash: it is restorable for 30 days, and the
 * pages show it again when it is restored. Copies a browser or a CDN already has are not taken back (ADR 0023 §8).
 */
function UsageWarning({ usage }: { usage: MediaUsage | null }) {
  const list = (titles: string[], count: number) => (titles.length ? `: ${titles.join(", ")}${count > titles.length ? ", …" : ""}` : "");
  return (
    <div className="grid gap-1 text-sm" data-testid="media-usage">
      {usage === null ? (
        <p>Where it is used could not be checked. Pages that show it stop showing it at once.</p>
      ) : usage.published || usage.drafts || usage.logo || usage.favicon ? (
        <>
          {usage.published ? (
            <p className="font-medium">
              {usage.published === 1 ? "1 published page or post shows it" : `${usage.published} published pages and posts show it`}
              {list(usage.publishedTitles, usage.published)}. They stop showing it at once.
            </p>
          ) : null}
          {usage.drafts ? (
            <p>
              {usage.drafts === 1 ? "1 draft holds it" : `${usage.drafts} drafts hold it`}
              {list(usage.draftTitles, usage.drafts)}.
            </p>
          ) : null}
          {usage.logo ? <p>It is the site&rsquo;s logo: the header shows the site&rsquo;s name instead.</p> : null}
          {usage.favicon ? <p>It is the site&rsquo;s favicon: the site has none while it is in the trash.</p> : null}
        </>
      ) : (
        <p>No page or post uses it.</p>
      )}
      <p className="text-xs text-muted-foreground">
        It can be restored for 30 days, and pages show it again; after that it is deleted for good. A copy a visitor&rsquo;s browser already has may still show
        for a while.
      </p>
    </div>
  );
}
