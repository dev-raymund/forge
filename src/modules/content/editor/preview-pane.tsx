"use client";

import { Eye, ExternalLink } from "lucide-react";
import { useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PREVIEW_FRAME_SANDBOX } from "@/platform/routing/preview-frame";
import { previewLinkAction } from "../actions";

/**
 * Previews in the admin (M7-4; plan §9 "Preview"; ADR 0027). A preview is a site page (`/_forge/preview/{token}`),
 * shown here in a frame and offered in a new tab:
 *
 *   PreviewFrame    the frame: sandboxed (`PREVIEW_FRAME_SANDBOX`: in production no same origin, so no access to the
 *                   admin; no forms, no top navigation), no referrer; the page itself refuses every framing but the
 *                   admin's (`frame-ancestors 'self'`)
 *   PreviewButton   the draft as it is saved: what is typed is saved first, then a link is made (15 minutes)
 *
 * Opening and closing a preview changes nothing: no draft, no revision, no record. The editor stays as it was, with
 * what is typed, its autosave and its local copy.
 */

export function PreviewFrame({ path, title }: { path: string; title: string }) {
  return (
    <div className="grid gap-2">
      <iframe
        src={path}
        title={title}
        data-testid="preview-frame"
        sandbox={PREVIEW_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        className="h-[65dvh] w-full rounded-lg border bg-white"
      />
      <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>The link works for 15 minutes, for you only.</span>
        <a href={path} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4">
          Open in a new tab
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      </p>
    </div>
  );
}

type Ready = { version: number } | { error: string };

/** "Preview": the draft as saved, in the site's theme. For editors, what is typed is saved first; a reader previews the draft as it is. */
export function PreviewButton({
  orgSlug, siteSlug, entryId, beforePreview, disabled,
}: {
  orgSlug: string;
  siteSlug: string;
  entryId: string;
  /** Saves what is typed (an editor), or nothing to save (a reader): null to go on, or why not. */
  beforePreview: () => Promise<Ready | null>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function preview() {
    if (pending) return;
    setPending(true);
    setError(null);
    setPath(null);
    setOpen(true);
    try {
      const ready = await beforePreview();
      if (ready && "error" in ready) return setError(`Not previewed: ${ready.error}`);
      const result = await previewLinkAction(orgSlug, siteSlug, entryId);
      if (result.ok) setPath(result.data.path);
      else setError(result.error);
    } catch {
      setError("The preview could not be opened: the connection failed. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" className="h-9 px-3" onClick={preview} disabled={disabled || pending} aria-busy={pending || undefined}>
        <Eye aria-hidden="true" />
        Preview
      </Button>
      {open ? (
        <DialogContent className="max-h-[96dvh] overflow-y-auto sm:max-w-5xl" data-testid="preview-dialog">
          <DialogHeader>
            <DialogTitle>Preview of the draft</DialogTitle>
            <DialogDescription>The draft as it is saved, as the site would show it. Nothing is published, and nothing changes by looking.</DialogDescription>
          </DialogHeader>
          {error ? (
            <div className="grid justify-items-start gap-2">
              <FormAlert tone="error">{error}</FormAlert>
              <Button type="button" variant="outline" className="h-9 px-3" onClick={preview}>
                Try again
              </Button>
            </div>
          ) : path ? (
            <PreviewFrame path={path} title="Preview of the draft" />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Saving and opening the preview…
            </p>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
