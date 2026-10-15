"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { FormAlert } from "@/components/admin/form";
import { Moment } from "@/components/admin/local-day";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IDLE, type FormState } from "@/platform/forms";
import { purgeEntryAction, restoreEntryAction } from "../actions";
import type { TrashInfo } from "../queries";

/**
 * The trash of a site's pages or posts (M7-1): what is in it, since when, until when, and what went with each page.
 * Restore brings it back as a draft (and the pages trashed with it), or says why not: an address taken since, a page
 * above it still in the trash. "Delete permanently" asks first, and says how many pages go. Each row offers only what
 * the member may do; the server decides again.
 */

export type TrashItem = { id: string; title: string; path: string; trash: TrashInfo };

const messageOf = (state: FormState, fallback: string) => state.message ?? (state.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined) ?? fallback;

export function TrashList({ orgSlug, siteSlug, type, items }: { orgSlug: string; siteSlug: string; type: "page" | "post"; items: TrashItem[] }) {
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string; id?: string } | null>(null);
  const [purging, setPurging] = useState<TrashItem | null>(null);
  const [pending, startTransition] = useTransition();
  const noun = type === "page" ? "page" : "post";

  const run = (item: TrashItem, work: () => Promise<FormState>, fallback: string, after?: () => void) =>
    startTransition(async () => {
      setNotice(null);
      try {
        const state = await work();
        if (state.status === "success") {
          setNotice({ tone: "success", text: state.message ?? "Done." });
          after?.();
        } else setNotice({ tone: "error", text: messageOf(state, fallback), id: item.id });
      } catch {
        setNotice({ tone: "error", text: `${fallback} The connection failed. Try again.`, id: item.id });
      }
    });

  return (
    <div className="mt-6 grid gap-4" data-testid="trash">
      <p className="text-sm text-muted-foreground">
        {type === "page" ? "Pages" : "Posts"} in the trash are not on the site. Restored, they come back as drafts. Each is deleted for good 30 days after it
        went to the trash.
      </p>
      <div aria-live="polite" className="empty:hidden">
        {notice && !notice.id ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
      </div>
      {items.length ? (
        <ul className="divide-y rounded-lg border" data-testid="trash-items">
          {items.map((item) => (
            <li key={item.id} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4 sm:p-4" data-testid="trash-item" data-title={item.title}>
              <div className="grid min-w-0 gap-1">
                <p className="font-medium wrap-anywhere">{item.title || "Untitled"}</p>
                <p className="text-sm text-muted-foreground wrap-anywhere">
                  Was at {item.path}
                  {item.trash.below ? ` · with ${item.trash.below} ${item.trash.below === 1 ? "page" : "pages"} below it` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  In the trash since <Moment iso={item.trash.trashedAt.toISOString()} /> · deleted for good after <Moment iso={item.trash.purgeAt.toISOString()} />
                </p>
                {item.trash.underTrashedPage ? <p className="text-xs text-muted-foreground">Under a page in the trash: restore that page first.</p> : null}
                {notice?.id === item.id ? (
                  <FormAlert tone="error" className="mt-1">
                    {notice.text}
                  </FormAlert>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {item.trash.canRestore ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 px-3"
                    disabled={pending}
                    onClick={() => run(item, () => restoreEntryAction(orgSlug, siteSlug, item.id, IDLE, new FormData()), "Not restored.")}
                  >
                    <RotateCcw aria-hidden="true" className="size-4" />
                    Restore
                  </Button>
                ) : null}
                {item.trash.canPurge ? (
                  <Button type="button" variant="outline" className="h-9 px-3 text-destructive" disabled={pending} onClick={() => setPurging(item)}>
                    <Trash2 aria-hidden="true" className="size-4" />
                    Delete permanently…
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground" data-testid="trash-empty">
          The trash is empty.
        </p>
      )}

      <Dialog open={purging !== null} onOpenChange={(open) => !open && setPurging(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {purging?.title || `this ${noun}`} permanently?</DialogTitle>
            <DialogDescription>
              {purging?.trash.below ? `It and the ${purging.trash.below} ${purging.trash.below === 1 ? "page" : "pages"} below it are` : "It is"} deleted now, with
              {purging?.trash.below ? " their" : " its"} text and history. This cannot be undone. Images stay in the media library.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10 px-4" onClick={() => setPurging(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-10 px-4"
              disabled={pending}
              aria-busy={pending || undefined}
              onClick={() => {
                const item = purging!;
                setPurging(null);
                run(item, () => purgeEntryAction(orgSlug, siteSlug, item.id, IDLE, new FormData()), "Not deleted.");
              }}
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
