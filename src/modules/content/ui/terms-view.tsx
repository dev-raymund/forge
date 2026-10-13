"use client";

import { Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState, useTransition } from "react";
import { z } from "zod";
import { Field, FormAlert, SelectField, SubmitButton, useActionForm } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IDLE, type FormState } from "@/platform/forms";
import { createTermAction, deleteTermAction, updateTermAction } from "../actions";
import { TERM_DESCRIPTION_MAX, TERM_NAME_MAX, typedSlug } from "../validation";

/**
 * A site's categories or tags (M5-8; plan §19 `/…/posts/categories`, `/…/posts/tags`): each with its archive's
 * address and how many published posts and drafts carry it; a form to add one; Edit (name, slug, description, a
 * category's parent) and Delete, which says what it will be taken off first. Categories nest one level: a
 * subcategory is listed under its parent. The server decides every change, and the page shows it after it is done.
 */

export type TermRowView = { id: string; name: string; slug: string; description: string; parentId: string | null; posts: number; drafts: number };

const LINK = "rounded-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25";
const messageOf = (state: FormState, fallback: string) => (state.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined) ?? state.message ?? fallback;
const usage = (term: TermRowView) =>
  term.posts || term.drafts
    ? [term.posts ? `${term.posts} published ${term.posts === 1 ? "post" : "posts"}` : null, term.drafts ? `${term.drafts} ${term.drafts === 1 ? "draft" : "drafts"}` : null].filter(Boolean).join(" · ")
    : "Not used yet";

const createSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(TERM_NAME_MAX, `Use at most ${TERM_NAME_MAX} characters.`),
  slug: z.union([z.literal(""), typedSlug]),
  description: z.string().trim().max(TERM_DESCRIPTION_MAX, `Use at most ${TERM_DESCRIPTION_MAX} characters.`),
});

export function TermsView({
  orgSlug, siteSlug, taxonomy, terms, archiveBase, postsHref,
}: { orgSlug: string; siteSlug: string; taxonomy: "category" | "tag"; terms: TermRowView[]; archiveBase: string; postsHref: string }) {
  const noun = taxonomy === "category" ? "category" : "tag";
  const plural = taxonomy === "category" ? "Categories" : "Tags";
  const [editing, setEditing] = useState<TermRowView | null>(null);
  const [deleting, setDeleting] = useState<TermRowView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const topLevel = terms.filter((term) => !term.parentId || !terms.some((parent) => parent.id === term.parentId));
  const ordered = taxonomy === "category" ? topLevel.flatMap((term) => [term, ...terms.filter((child) => child.parentId === term.id)]) : terms;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <p className="text-sm">
        <Link href={postsHref} className={LINK}>
          Posts
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{plural}</h1>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        {taxonomy === "category"
          ? "The blog's sections. A category can sit under another, one level deep. Each has its own page on the site."
          : "Words a post is about. Each tag has its own page on the site, listing its posts."}
      </p>

      <CreateTermForm orgSlug={orgSlug} siteSlug={siteSlug} taxonomy={taxonomy} parents={topLevel.filter(() => taxonomy === "category")} />

      <div aria-live="polite" className="mt-6 empty:hidden">
        {notice ? <FormAlert tone="success">{notice}</FormAlert> : null}
      </div>

      {ordered.length ? (
        <ul className="mt-6 divide-y rounded-lg border" data-testid="terms">
          {ordered.map((term) => (
            <li key={term.id} data-testid="term-row" data-term={term.name} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-4">
              <div className={`grid min-w-0 gap-0.5 ${term.parentId ? "pl-6" : ""}`}>
                <span className="font-medium wrap-anywhere">
                  {term.parentId ? <span aria-hidden="true">↳ </span> : null}
                  {term.name}
                </span>
                <span className="text-sm text-muted-foreground wrap-anywhere">{`${archiveBase}/${term.slug}`}</span>
                {term.description ? <span className="text-sm wrap-anywhere">{term.description}</span> : null}
                <span className="text-sm text-muted-foreground" data-testid="term-usage">
                  {usage(term)}
                </span>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="h-9 px-3" onClick={() => setEditing(term)} aria-label={`Edit ${term.name}`}>
                  <Pencil aria-hidden="true" className="size-4" />
                  Edit
                </Button>
                <Button type="button" variant="outline" className="h-9 px-3 text-destructive" onClick={() => setDeleting(term)} aria-label={`Delete ${term.name}`}>
                  <Trash2 aria-hidden="true" className="size-4" />
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-6 rounded-lg border border-dashed p-6 text-sm text-muted-foreground" data-testid="no-terms">
          This site has no {plural.toLowerCase()} yet. Add the first one above{taxonomy === "tag" ? ", or from a post's settings while you write" : ""}.
        </p>
      )}

      {editing ? (
        <EditTermDialog
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          term={editing}
          noun={noun}
          parents={taxonomy === "category" ? topLevel.filter((term) => term.id !== editing.id) : null}
          hasChildren={terms.some((term) => term.parentId === editing.id)}
          onClose={() => setEditing(null)}
          onDone={(message) => {
            setEditing(null);
            setNotice(message);
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteTermDialog
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          term={deleting}
          noun={noun}
          subcategories={terms.filter((term) => term.parentId === deleting.id).length}
          onClose={() => setDeleting(null)}
          onDone={(message) => {
            setDeleting(null);
            setNotice(message);
          }}
        />
      ) : null}
    </main>
  );
}

function CreateTermForm({ orgSlug, siteSlug, taxonomy, parents }: { orgSlug: string; siteSlug: string; taxonomy: "category" | "tag"; parents: TermRowView[] }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(createTermAction.bind(null, orgSlug, siteSlug, taxonomy), createSchema);
  const noun = taxonomy === "category" ? "category" : "tag";
  // A new term was made: the form is empty again for the next one (the list above has it, from the server).
  useEffect(() => {
    if (state.status === "success") formProps.ref.current?.reset();
  }, [state, formProps.ref]);
  return (
    <form {...formProps} className="mt-8 grid gap-4 rounded-lg border p-4 sm:grid-cols-2" aria-label={`Add a ${noun}`}>
      <h2 className="text-sm font-semibold sm:col-span-2">Add a {noun}</h2>
      {message ? (
        <div className="sm:col-span-2">
          <FormAlert tone={state.status === "error" ? "error" : "success"}>{message}</FormAlert>
        </div>
      ) : null}
      <Field name="name" label="Name" maxLength={TERM_NAME_MAX} errors={fieldErrors.name} autoComplete="off" defaultValue={state.status === "error" ? state.values?.name : ""} />
      <Field name="slug" label="Slug" errors={fieldErrors.slug} autoComplete="off" spellCheck={false} hint="Leave it empty to make one from the name." defaultValue={state.status === "error" ? state.values?.slug : ""} />
      {taxonomy === "category" ? (
        <SelectField
          name="parentId"
          label="Under"
          options={[{ value: "", label: "No parent (top level)" }, ...parents.map((parent) => ({ value: parent.id, label: parent.name }))]}
          errors={fieldErrors.parentId}
        />
      ) : null}
      <Field name="description" label="Description" maxLength={TERM_DESCRIPTION_MAX} errors={fieldErrors.description} hint="Shown on its page on the site." defaultValue={state.status === "error" ? state.values?.description : ""} />
      <div className="sm:col-span-2">
        <SubmitButton pending={pending} pendingLabel="Adding…" className="w-auto px-4">
          Add {noun}
        </SubmitButton>
      </div>
    </form>
  );
}

function EditTermDialog({
  orgSlug, siteSlug, term, noun, parents, hasChildren, onClose, onDone,
}: {
  orgSlug: string; siteSlug: string; term: TermRowView; noun: string; parents: TermRowView[] | null; hasChildren: boolean; onClose: () => void; onDone: (message: string) => void;
}) {
  const ids = { name: useId(), slug: useId(), description: useId(), parent: useId() };
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          aria-label={`Edit ${term.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const slug = typedSlug.safeParse(data.get("slug"));
            if (!slug.success) return setError(slug.error.issues[0]?.message ?? "Use lowercase letters, numbers and single hyphens.");
            startTransition(async () => {
              const state = await updateTermAction(orgSlug, siteSlug, term.id, IDLE, data);
              if (state.status === "error") setError(messageOf(state, `The ${noun} could not be saved.`));
              else onDone(state.message ?? "Saved.");
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit {term.name}</DialogTitle>
            <DialogDescription>A new slug moves its page on the site to a new address; the old one stops working.</DialogDescription>
          </DialogHeader>
          {error ? <FormAlert tone="error">{error}</FormAlert> : null}
          <div className="grid gap-2">
            <Label htmlFor={ids.name}>Name</Label>
            <Input id={ids.name} name="name" defaultValue={term.name} maxLength={TERM_NAME_MAX} required className="h-10" autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.slug}>Slug</Label>
            <Input id={ids.slug} name="slug" defaultValue={term.slug} className="h-10" autoComplete="off" spellCheck={false} />
          </div>
          {parents ? (
            <div className="grid gap-2">
              <Label htmlFor={ids.parent}>Under</Label>
              <select
                id={ids.parent}
                name="parentId"
                defaultValue={term.parentId ?? ""}
                disabled={hasChildren}
                aria-describedby={hasChildren ? `${ids.parent}-hint` : undefined}
                className="h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 disabled:opacity-60 md:text-sm"
              >
                <option value="">No parent (top level)</option>
                {parents.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.name}
                  </option>
                ))}
              </select>
              {hasChildren ? (
                <p id={`${ids.parent}-hint`} className="text-sm text-muted-foreground">
                  It has subcategories, so it stays at the top level.
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor={ids.description}>Description</Label>
            <Input id={ids.description} name="description" defaultValue={term.description} maxLength={TERM_DESCRIPTION_MAX} className="h-10" />
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

function DeleteTermDialog({
  orgSlug, siteSlug, term, noun, subcategories, onClose, onDone,
}: { orgSlug: string; siteSlug: string; term: TermRowView; noun: string; subcategories: number; onClose: () => void; onDone: (message: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {term.name}?</DialogTitle>
          <DialogDescription>
            {term.posts || term.drafts ? `It is taken off ${usage(term).replace(" · ", " and ")}. The posts themselves stay.` : `No post uses this ${noun}.`}
            {subcategories ? ` Its ${subcategories === 1 ? "subcategory moves" : `${subcategories} subcategories move`} to the top level.` : ""} Its page on the site stops working.
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
                const state = await deleteTermAction(orgSlug, siteSlug, term.id, IDLE, new FormData());
                if (state.status === "error") setError(messageOf(state, `The ${noun} could not be deleted.`));
                else onDone(state.message ?? "Deleted.");
              })
            }
          >
            {pending ? "Deleting…" : `Delete ${noun}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
