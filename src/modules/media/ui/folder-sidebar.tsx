"use client";

import { Folder, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState, useTransition } from "react";
import { z } from "zod";
import { FormAlert, SubmitButton, useActionForm } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IDLE } from "@/platform/forms";
import { createFolderAction, deleteFolderAction, renameFolderAction } from "../actions";
import { libraryHref, type LibraryQuery } from "../library-query";

/**
 * The library's folders (M6-3; one level, plan §8): "All media", the files in no folder, and each folder with how
 * many files it holds. Those who manage folders (`media.update.any`) create, rename and delete empty ones here.
 */

const FOLDER_NAME_MAX = 100;
const nameSchema = z.object({ name: z.string().trim().min(1, "Enter a name.").max(FOLDER_NAME_MAX, `Use at most ${FOLDER_NAME_MAX} characters.`) });
const ITEM =
  "flex min-w-0 items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-foreground/25 aria-[current=page]:bg-muted aria-[current=page]:font-medium";

export function FolderSidebar({
  orgSlug, siteSlug, folders, query, basePath, canManage,
}: { orgSlug: string; siteSlug: string; folders: { id: string; name: string; files: number }[]; query: LibraryQuery; basePath: string; canManage: boolean }) {
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string; files: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const href = (folder?: string) => libraryHref(basePath, { view: query.view, sort: query.sort }, { folder, page: 1 });
  const current = query.trash ? null : (query.folder ?? "all");

  return (
    <nav aria-label="Folders" className="grid content-start gap-3" data-testid="folders">
      <ul className="grid gap-1">
        <li>
          <Link href={href()} className={ITEM} aria-current={current === "all" ? "page" : undefined}>
            All media
          </Link>
        </li>
        <li>
          <Link href={href("none")} className={ITEM} aria-current={current === "none" ? "page" : undefined}>
            In no folder
          </Link>
        </li>
        {folders.map((folder) => (
          <li key={folder.id} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1" data-testid="folder" data-folder={folder.name}>
            <Link href={href(folder.id)} className={ITEM} aria-current={current === folder.id ? "page" : undefined}>
              <span className="flex min-w-0 items-center gap-2">
                <Folder aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate">{folder.name}</span>
              </span>
              <span className="text-xs text-muted-foreground" aria-label={`${folder.files} ${folder.files === 1 ? "file" : "files"}`}>
                {folder.files}
              </span>
            </Link>
            {canManage ? (
              <span className="flex">
                <Button type="button" variant="ghost" className="size-8 p-0" onClick={() => setRenaming(folder)} aria-label={`Rename ${folder.name}`}>
                  <Pencil aria-hidden="true" className="size-4" />
                </Button>
                <Button type="button" variant="ghost" className="size-8 p-0 text-destructive" onClick={() => setDeleting(folder)} aria-label={`Delete ${folder.name}`}>
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <div aria-live="polite" className="empty:hidden">
        {notice ? <FormAlert tone="success">{notice}</FormAlert> : null}
      </div>
      {canManage ? <CreateFolderForm orgSlug={orgSlug} siteSlug={siteSlug} /> : null}

      {renaming ? (
        <RenameFolderDialog
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          folder={renaming}
          onClose={() => setRenaming(null)}
          onDone={(text) => {
            setRenaming(null);
            setNotice(text);
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteFolderDialog
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          folder={deleting}
          onClose={() => setDeleting(null)}
          onDone={(text) => {
            setDeleting(null);
            setNotice(text);
          }}
        />
      ) : null}
    </nav>
  );
}

function CreateFolderForm({ orgSlug, siteSlug }: { orgSlug: string; siteSlug: string }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(createFolderAction.bind(null, orgSlug, siteSlug), nameSchema);
  const id = useId();
  useEffect(() => {
    if (state.status === "success") formProps.ref.current?.reset();
  }, [state, formProps.ref]);
  const error = fieldErrors.name?.[0];
  return (
    <form {...formProps} className="grid gap-2 rounded-lg border p-3" aria-label="Create a folder">
      {message ? <FormAlert tone={state.status === "error" ? "error" : "success"}>{message}</FormAlert> : null}
      <Label htmlFor={id}>New folder</Label>
      <Input
        id={id}
        name="name"
        maxLength={FOLDER_NAME_MAX}
        autoComplete="off"
        className="h-10"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        defaultValue={state.status === "error" ? state.values?.name : ""}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <SubmitButton pending={pending} pendingLabel="Creating…" className="w-auto justify-self-start px-4">
        Create folder
      </SubmitButton>
    </form>
  );
}

const messageOf = (state: { message?: string; fieldErrors?: Record<string, string[]> }, fallback: string) =>
  (state.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined) ?? state.message ?? fallback;

function RenameFolderDialog({
  orgSlug, siteSlug, folder, onClose, onDone,
}: { orgSlug: string; siteSlug: string; folder: { id: string; name: string }; onClose: () => void; onDone: (text: string) => void }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          aria-label={`Rename ${folder.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const checked = nameSchema.safeParse({ name: data.get("name") });
            if (!checked.success) return setError(checked.error.issues[0]?.message ?? "Enter a name.");
            startTransition(async () => {
              const state = await renameFolderAction(orgSlug, siteSlug, folder.id, IDLE, data);
              if (state.status === "error") setError(messageOf(state, "The folder could not be renamed."));
              else onDone(state.message ?? "Folder renamed.");
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {folder.name}</DialogTitle>
            <DialogDescription>Its files stay in it.</DialogDescription>
          </DialogHeader>
          {error ? <FormAlert tone="error">{error}</FormAlert> : null}
          <div className="grid gap-2">
            <Label htmlFor={id}>Name</Label>
            <Input id={id} name="name" defaultValue={folder.name} maxLength={FOLDER_NAME_MAX} required className="h-10" autoComplete="off" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10 px-4" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className="h-10 px-4" disabled={pending} aria-busy={pending || undefined}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteFolderDialog({
  orgSlug, siteSlug, folder, onClose, onDone,
}: { orgSlug: string; siteSlug: string; folder: { id: string; name: string; files: number }; onClose: () => void; onDone: (text: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {folder.name}?</DialogTitle>
          <DialogDescription>
            {folder.files
              ? `It holds ${folder.files} ${folder.files === 1 ? "file" : "files"}. Move or trash ${folder.files === 1 ? "it" : "them"} first: only an empty folder can be deleted.`
              : "Only the folder goes. Files in the trash that were in it come back in no folder."}
          </DialogDescription>
        </DialogHeader>
        {error ? <FormAlert tone="error">{error}</FormAlert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" className="h-10 px-4" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-10 px-4"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() =>
              startTransition(async () => {
                const state = await deleteFolderAction(orgSlug, siteSlug, folder.id);
                if (state.status === "error") setError(messageOf(state, "The folder could not be deleted."));
                else onDone(state.message ?? "Folder deleted.");
              })
            }
          >
            {pending ? "Deleting…" : "Delete folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
