"use client";

import Link from "next/link";
import { z } from "zod";
import { Field, FormAlert, SelectField, SubmitButton, useActionForm } from "@/components/admin/form";
import { createEntryAction } from "../actions";
import type { ContentTypeKey } from "../types/definition";
import { ENTRY_TITLE_MAX } from "../validation";

/**
 * The new page and new post forms (M5-7; plan §19: "small forms: title, and parent or template"). The action creates
 * the entry (`createEntryAction`, M5-3) and the browser goes on to its editor. Nothing is created on GET.
 *
 *   page   title, the page above it, its template; "make it the home page" for those who may set the homepage
 *   post   title; the author, for those who may credit someone else
 *
 * The lists offered here are what the server sent; it checks every choice again (a parent of this site, an author
 * who is a member, who may credit whom).
 */

const LINK = "rounded-sm text-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25";
const schema = z.object({ title: z.string().trim().max(ENTRY_TITLE_MAX, `Use at most ${ENTRY_TITLE_MAX} characters.`) });

export type NewEntryFormProps = {
  orgSlug: string;
  siteSlug: string;
  type: ContentTypeKey;
  cancelHref: string;
  /** Pages it could go under (title and path, in tree order, with their depth); a page's form only. */
  parents?: { id: string; label: string }[];
  templates?: { value: string; label: string }[];
  /** "Make it the home page", for those who may set the homepage. Ticked to start with when the site has none. */
  home?: { offered: boolean; checked: boolean };
  /** Who it may be credited to, for those who may credit others: the caller first. */
  authors?: { userId: string; name: string }[];
};

export function NewEntryForm({ orgSlug, siteSlug, type, cancelHref, parents = [], templates = [], home, authors = [] }: NewEntryFormProps) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(createEntryAction.bind(null, orgSlug, siteSlug, type), schema);
  const noun = type === "page" ? "page" : "post";
  return (
    <form {...formProps} className="grid max-w-xl gap-5" aria-label={`New ${noun}`}>
      {message && state.status === "error" ? <FormAlert tone="error">{message}</FormAlert> : null}
      <Field name="title" label="Title" maxLength={ENTRY_TITLE_MAX} defaultValue={state.values?.title ?? ""} errors={fieldErrors.title} autoComplete="off" autoFocus
        hint={`The ${noun}'s address is made from it. You can change both in the editor.`} />
      {type === "page" ? (
        <>
          <SelectField
            name="parentId"
            label="Under"
            options={[{ value: "", label: "The top level of the site" }, ...parents.map((parent) => ({ value: parent.id, label: parent.label }))]}
            defaultValue={state.values?.parentId ?? ""}
            errors={fieldErrors.parentId}
            hint="The page above this one: its address starts with that page's."
          />
          <SelectField name="template" label="Template" options={templates} defaultValue={state.values?.template ?? ""} errors={fieldErrors.template} />
          {home?.offered ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="home" defaultChecked={home.checked} className="mt-0.5 size-4" />
              <span>
                <span className="font-medium">Make it the home page</span>
                <span className="block text-muted-foreground">It takes the site&rsquo;s address. The current home page, if there is one, moves to its own address.</span>
              </span>
            </label>
          ) : null}
        </>
      ) : authors.length > 1 ? (
        <SelectField
          name="authorId"
          label="Author"
          options={authors.map((author) => ({ value: author.userId, label: author.name }))}
          defaultValue={state.values?.authorId || authors[0]!.userId}
          errors={fieldErrors.authorId}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <SubmitButton pending={pending} pendingLabel="Creating…" className="w-auto px-4">
          Create {noun}
        </SubmitButton>
        <Link href={cancelHref} className={LINK}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
