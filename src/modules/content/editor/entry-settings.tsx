"use client";

import { useId, useState, useTransition } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { IDLE, type FormState } from "@/platform/forms";
import { changeAuthorAction, setHomepageAction } from "../actions";
import { HOME_PATH, parentDir, pathUnder, postPath, reservedPathReason } from "../paths";
import type { EditorEntry, TermOption } from "../queries";
import { MovePageDialog, pagesOutside, type MovablePage } from "../ui/move-page-dialog";
import { ENTRY_EXCERPT_MAX, typedSlug } from "../validation";

/**
 * The entry's settings, beside the text (M5-7 criterion 4; plan §6.3 "entry sidebar"):
 *
 *   saved with the draft (autosave)    the slug, a page's template, a post's excerpt, categories and tags
 *   done at once (their own action)    a page's parent (movePageAction), the author (changeAuthorAction, Owner–Editor),
 *                                      "Set as home page" (setHomepageAction, Owner and Admin)
 *   not yet                            a post's featured image (the media library, M6-4)
 *
 * A draft field goes into the autosave payload only once it has been changed here, and a slug only once it passes
 * the same rules the server applies (format, length, reserved addresses): a slug being typed never blocks the saving
 * of the text. A slug another entry holds is refused when publishing, with the address it collides on.
 */

export type DraftFields = { slug?: string; template?: string | null; excerpt?: string; termIds?: string[] };
export type SidebarChoices = { pages: MovablePage[]; members: { userId: string; name: string }[]; terms: TermOption[] };
/** What the sidebar's immediate actions change, kept by the editor so its header follows. */
export type EntryPlace = { path: string; parentId: string | null; isHome: boolean; authorId: string | null; authorName: string | null };

const CONTROL =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 disabled:opacity-60 md:text-sm";
const TEMPLATES = [
  { value: "", label: "Default" },
  { value: "full-width", label: "Full width" },
  { value: "landing", label: "Landing page" },
];

const messageOf = (state: FormState, fallback: string) => (state.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined) ?? state.message ?? fallback;

export function EntrySettings({
  orgSlug, siteSlug, entry, title, status, place, fields, onFields, editable, choices, onPlace,
}: {
  orgSlug: string;
  siteSlug: string;
  entry: EditorEntry;
  title: string;
  /** The live status: a published entry's address changes when it is published again. */
  status: string;
  place: EntryPlace;
  fields: DraftFields;
  onFields: (next: DraftFields) => void;
  /** Draft fields can be changed (an editor that may edit, not in conflict, holding only blocks it knows). */
  editable: boolean;
  choices: SidebarChoices;
  onPlace: (next: Partial<EntryPlace>, message: string) => void;
}) {
  const { settings } = entry;
  const isPage = entry.type === "page";
  const ids = { slug: useId(), template: useId(), excerpt: useId(), author: useId() };
  const [slugText, setSlugText] = useState(fields.slug ?? settings.slug);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [homeOpen, setHomeOpen] = useState(false);
  const [authorId, setAuthorId] = useState(place.authorId ?? "");
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const slug = fields.slug ?? settings.slug;
  const pathFor = (value: string) => (isPage ? pathUnder(parentDir(place.path), value) : postPath(value, settings.blogPath));
  const draftPath = place.isHome ? HOME_PATH : pathFor(slug);

  function changeSlug(value: string) {
    setSlugText(value);
    const parsed = typedSlug.safeParse(value);
    if (!parsed.success) return setSlugError(parsed.error.issues[0]?.message ?? "Use lowercase letters, numbers and single hyphens.");
    const reserved = reservedPathReason(pathFor(parsed.data), { type: entry.type, blogPath: settings.blogPath });
    if (reserved) return setSlugError(reserved);
    setSlugError(null);
    onFields({ ...fields, slug: parsed.data });
  }

  function run(action: () => Promise<FormState>, done: (state: FormState) => void) {
    setActionError(null);
    startTransition(async () => {
      const state = await action();
      if (state.status === "error") setActionError(messageOf(state, "That did not work. Try again."));
      else done(state);
    });
  }

  const termIds = fields.termIds ?? settings.termIds;
  const terms = { category: choices.terms.filter((term) => term.taxonomy === "category"), tag: choices.terms.filter((term) => term.taxonomy === "tag") };

  return (
    <section aria-label={isPage ? "Page settings" : "Post settings"} data-testid="entry-settings" className="grid content-start gap-5 rounded-xl border p-4">
      <h2 className="text-sm font-semibold">{isPage ? "Page settings" : "Post settings"}</h2>
      {actionError ? <FormAlert tone="error">{actionError}</FormAlert> : null}

      <div className="grid gap-2">
        <Label htmlFor={ids.slug}>Slug</Label>
        {place.isHome ? (
          <p className="text-sm text-muted-foreground" data-testid="home-address">
            The home page is at the site&rsquo;s own address.
          </p>
        ) : (
          <>
            <input
              id={ids.slug}
              value={slugText}
              onChange={(event) => changeSlug(event.target.value)}
              disabled={!editable}
              aria-invalid={slugError ? true : undefined}
              aria-describedby={`${ids.slug}-address${slugError ? ` ${ids.slug}-error` : ""}`}
              autoComplete="off"
              spellCheck={false}
              className={`h-10 ${CONTROL}`}
            />
            {slugError ? (
              <p id={`${ids.slug}-error`} className="text-sm text-destructive" role="alert">
                {slugError}
              </p>
            ) : null}
          </>
        )}
        <p id={`${ids.slug}-address`} className="text-sm text-muted-foreground wrap-anywhere" data-testid="entry-path">
          Address: <span className="font-medium text-foreground">{draftPath}</span>
          {status === "published" && draftPath !== place.path ? ` (now ${place.path}; it changes when you publish)` : ""}
        </p>
      </div>

      {isPage ? (
        <div className="grid gap-2">
          <p className="text-sm font-medium">Under</p>
          <p className="text-sm text-muted-foreground wrap-anywhere" data-testid="entry-parent">
            {place.parentId ? (choices.pages.find((page) => page.id === place.parentId)?.title || "Another page") : "The top level of the site"}
          </p>
          {settings.canArrange ? (
            <Button type="button" variant="outline" className="h-9 justify-self-start px-3" onClick={() => setMoving(true)} disabled={pending}>
              Move…
            </Button>
          ) : null}
        </div>
      ) : null}

      {isPage ? (
        <div className="grid gap-2">
          <Label htmlFor={ids.template}>Template</Label>
          <select
            id={ids.template}
            value={(fields.template !== undefined ? fields.template : settings.template) ?? ""}
            onChange={(event) => onFields({ ...fields, template: event.target.value || null })}
            disabled={!editable}
            className={`h-10 ${CONTROL}`}
          >
            {TEMPLATES.map((template) => (
              <option key={template.value} value={template.value}>
                {template.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="grid gap-2">
            <Label htmlFor={ids.excerpt}>Excerpt</Label>
            <textarea
              id={ids.excerpt}
              value={fields.excerpt ?? settings.excerpt}
              onChange={(event) => onFields({ ...fields, excerpt: event.target.value })}
              maxLength={ENTRY_EXCERPT_MAX}
              rows={3}
              disabled={!editable}
              className={`py-2 ${CONTROL}`}
            />
            <p className="text-sm text-muted-foreground">Shown in the blog&rsquo;s lists.</p>
          </div>
          {(["category", "tag"] as const).map((taxonomy) => (
            <fieldset key={taxonomy} className="grid gap-1.5" data-testid={`${taxonomy}-choices`}>
              <legend className="mb-1 text-sm font-medium">{taxonomy === "category" ? "Categories" : "Tags"}</legend>
              {terms[taxonomy].length ? (
                terms[taxonomy].map((term) => (
                  <label key={term.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={termIds.includes(term.id)}
                      disabled={!editable}
                      onChange={(event) => onFields({ ...fields, termIds: event.target.checked ? [...termIds, term.id] : termIds.filter((id) => id !== term.id) })}
                    />
                    <span className="wrap-anywhere">{term.name}</span>
                  </label>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">This site has no {taxonomy === "category" ? "categories" : "tags"} yet.</p>
              )}
            </fieldset>
          ))}
          <div className="grid gap-1.5" data-testid="featured-image">
            <p className="text-sm font-medium">Featured image</p>
            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">A featured image can be chosen once the media library is available.</p>
          </div>
        </>
      )}

      <div className="grid gap-2">
        {settings.canChangeAuthor && editable ? (
          <>
            <Label htmlFor={ids.author}>Author</Label>
            <select id={ids.author} value={authorId} onChange={(event) => setAuthorId(event.target.value)} className={`h-10 ${CONTROL}`}>
              {place.authorId && !choices.members.some((member) => member.userId === place.authorId) ? <option value={place.authorId}>A former member</option> : null}
              {choices.members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              className="h-9 justify-self-start px-3"
              disabled={pending || authorId === (place.authorId ?? "")}
              onClick={() => {
                const data = new FormData();
                data.set("authorId", authorId);
                run(
                  () => changeAuthorAction(orgSlug, siteSlug, entry.id, IDLE, data),
                  (state) => onPlace({ authorId, authorName: choices.members.find((member) => member.userId === authorId)?.name ?? null }, state.message ?? "Author changed."),
                );
              }}
            >
              Change author
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">Author</p>
            <p className="text-sm text-muted-foreground" data-testid="entry-author">
              {place.authorName ?? (place.authorId ? "A former member" : "No one")}
            </p>
          </>
        )}
      </div>

      {isPage && settings.canSetHomepage && !place.isHome ? (
        <div className="grid gap-2">
          <Button type="button" variant="outline" className="h-9 justify-self-start px-3" onClick={() => setHomeOpen(true)} disabled={pending}>
            Set as home page
          </Button>
        </div>
      ) : null}

      {moving ? (
        <MovePageDialog
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          page={{ id: entry.id, title, path: place.path, status, parentId: place.parentId }}
          options={pagesOutside(entry.id, choices.pages)}
          onClose={() => setMoving(false)}
          onMoved={(state) => {
            setMoving(false);
            onPlace({ path: state.values?.path ?? place.path, parentId: state.values?.parentId || null }, state.message ?? "Page moved.");
          }}
        />
      ) : null}

      <Dialog open={homeOpen} onOpenChange={setHomeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Make {title || "this page"} the home page?</DialogTitle>
            <DialogDescription>
              It takes the site&rsquo;s own address. The current home page moves to an address of its own, and the pages below both follow.
              {status === "published" ? " Visitors see the change at once." : " Visitors see it once this page is published."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10 px-4" onClick={() => setHomeOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              className="h-10 px-4"
              disabled={pending}
              onClick={() =>
                run(
                  () => setHomepageAction(orgSlug, siteSlug, entry.id, IDLE, new FormData()),
                  (state) => {
                    setHomeOpen(false);
                    onPlace({ isHome: true, path: HOME_PATH }, state.message ?? "This page is now the home page.");
                  },
                )
              }
            >
              Set as home page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
