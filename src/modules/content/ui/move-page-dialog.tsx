"use client";

import { useId, useState, useTransition } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { IDLE, type FormState } from "@/platform/forms";
import { movePageAction } from "../actions";
import { HOME_PATH, pathUnder } from "../paths";

/**
 * "Move under…" (M5-7): the pages a page may go under, and where its address will be. Used by the page tree and the
 * editor's sidebar. The server (`movePage`) decides: a loop, a page in the trash, a taken address are refused there.
 */

export type MovablePage = { id: string; title: string; path: string; status: string; parentId: string | null };

/** Every page but this one and those below it: the pages it may go under. */
export function pagesOutside<P extends { id: string; parentId: string | null }>(pageId: string, pages: readonly P[]): P[] {
  const below = new Set([pageId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const page of pages) {
      if (page.parentId && below.has(page.parentId) && !below.has(page.id)) {
        below.add(page.id);
        grew = true;
      }
    }
  }
  return pages.filter((page) => !below.has(page.id));
}

export function MovePageDialog({
  orgSlug, siteSlug, page, options, onClose, onMoved,
}: { orgSlug: string; siteSlug: string; page: MovablePage; options: readonly MovablePage[]; onClose: () => void; onMoved: (state: FormState) => void }) {
  const [parentId, setParentId] = useState(page.parentId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = useId();
  const parent = options.find((option) => option.id === parentId);
  const slug = page.path.split("/").at(-1) ?? "";
  const next = page.path === HOME_PATH ? HOME_PATH : pathUnder(parent?.path ?? "", slug);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          aria-label={`Move ${page.title || "Untitled"}`}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData();
            data.set("parentId", parentId);
            startTransition(async () => {
              const state = await movePageAction(orgSlug, siteSlug, page.id, IDLE, data);
              if (state.status === "error") setError(state.fieldErrors ? Object.values(state.fieldErrors).flat()[0]! : (state.message ?? "The page could not be moved."));
              else onMoved(state);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Move {page.title || "Untitled"}</DialogTitle>
            <DialogDescription>Choose the page it goes under. Its address starts with that page&rsquo;s.</DialogDescription>
          </DialogHeader>
          {error ? <FormAlert tone="error">{error}</FormAlert> : null}
          <div className="grid gap-2">
            <Label htmlFor={id}>Under</Label>
            <select
              id={id}
              value={parentId}
              onChange={(event) => {
                setParentId(event.target.value);
                setError(null);
              }}
              className="h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 md:text-sm"
            >
              <option value="">The top level of the site</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {`${option.title || "Untitled"} (${option.path})`}
                </option>
              ))}
            </select>
          </div>
          <p className="text-sm text-muted-foreground" data-testid="move-preview">
            {next === page.path ? "Its address stays " : "Its address becomes "}
            <span className="font-medium text-foreground wrap-anywhere">{next}</span>
            {next !== page.path ? ", and the pages below it move with it" : ""}.
            {page.status === "published" && next !== page.path ? " It is live: the old address stops working at once." : ""}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10 px-4" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className="h-10 px-4" aria-busy={pending || undefined} disabled={pending}>
              {pending ? "Moving…" : "Move page"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
