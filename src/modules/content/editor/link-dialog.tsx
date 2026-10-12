"use client";

import type { Editor } from "@tiptap/core";
import { FileText, Newspaper } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ENTRY_SEARCH_PATH } from "../admin-paths";
import { isSafeHref } from "../document/schema";
import type { ContentTypeKey } from "../types/definition";

/**
 * The link dialog (plan §6.1; M5-4): a web address, an email, a phone number,
 * a path on this site, or one of the site's pages and posts, found by title
 * from `/api/app/entries/search`. Pages and posts are linked as
 * `entry:{id}`, so a later change of their address never breaks the link.
 * Whatever is chosen is checked with the document's own rule (`isSafeHref`);
 * the server checks the saved document again.
 */

type Match = { id: string; type: ContentTypeKey; title: string; path: string; status: string };

export const LINK_RULE = "Use a web address (https://…), an email (mailto:…), a phone number (tel:…) or a path on this site (/about).";

export function LinkDialog({ editor, open, onOpenChange, orgSlug, siteSlug }: { editor: Editor; open: boolean; onOpenChange: (open: boolean) => void; orgSlug: string; siteSlug: string }) {
  const current = (editor.getAttributes("link").href as string | undefined) ?? "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted with the dialog: each opening starts from the link under the caret. */}
        {open ? <LinkForm editor={editor} current={current} orgSlug={orgSlug} siteSlug={siteSlug} close={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function LinkForm({ editor, current, orgSlug, siteSlug, close }: { editor: Editor; current: string; orgSlug: string; siteSlug: string; close: () => void }) {
  const [href, setHref] = useState(current.startsWith("entry:") ? "" : current);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Match[] | null>(null);
  const [searchError, setSearchError] = useState(false);
  const urlId = useId();
  const searchId = useId();

  // The site's pages and posts matching what is typed (the latest when nothing is), a quarter of a second after the last key.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ org: orgSlug, site: siteSlug, q: query });
        const response = await fetch(`${ENTRY_SEARCH_PATH}?${params}`, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { entries: Match[] };
        setResults(body.entries);
        setSearchError(false);
      } catch (cause) {
        if ((cause as Error).name !== "AbortError") setSearchError(true);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [orgSlug, siteSlug, query]);

  function apply(target: string, text: string) {
    if (!isSafeHref(target)) return setError(LINK_RULE);
    const chain = editor.chain().focus();
    if (editor.state.selection.empty && !editor.isActive("link")) {
      // Nothing selected: the link's own words are inserted, linked.
      chain.insertContent({ type: "text", text, marks: [{ type: "link", attrs: { href: target } }] }).run();
    } else {
      chain.extendMarkRange("link").setLink({ href: target }).run();
    }
    close();
  }

  return (
    <form
      className="grid gap-4"
      aria-label="Link"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const target = href.trim();
        apply(target, target);
      }}
    >
      <DialogHeader>
        <DialogTitle>Link</DialogTitle>
        <DialogDescription>Link to a page or post of this site, or enter an address.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <Label htmlFor={searchId}>Find a page or post</Label>
        <Input id={searchId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title" autoComplete="off" className="h-10" />
        {searchError ? (
          <p className="text-sm text-destructive">The pages and posts could not be loaded. Try again.</p>
        ) : results === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : results.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="link-no-results">
            {query.trim() ? "No page or post has that in its title." : "This site has no pages or posts yet."}
          </p>
        ) : (
          <ul className="grid max-h-56 gap-1 overflow-y-auto" aria-label="Pages and posts" data-testid="link-results">
            {results.map((match) => (
              <li key={match.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-foreground/25"
                  onClick={() => apply(`entry:${match.id}`, match.title || "Untitled")}
                >
                  {match.type === "page" ? <FileText aria-hidden="true" className="size-4 shrink-0" /> : <Newspaper aria-hidden="true" className="size-4 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate font-medium">{match.title || "Untitled"}</span>
                  <span className="shrink-0 text-muted-foreground">{match.path}</span>
                  {match.status !== "published" ? <span className="shrink-0 text-xs text-muted-foreground">Draft</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={urlId}>Or an address</Label>
        <Input
          id={urlId}
          value={href}
          onChange={(event) => {
            setHref(event.target.value);
            setError(null);
          }}
          placeholder="https://example.com"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${urlId}-error` : undefined}
          className="h-10"
        />
        {error ? (
          <p id={`${urlId}-error`} className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      {current.startsWith("entry:") ? <p className="text-sm text-muted-foreground">This text links to a page or post of this site.</p> : null}

      <DialogFooter>
        {current ? (
          <Button
            type="button"
            variant="outline"
            className="h-10 px-4 sm:mr-auto"
            onClick={() => {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              close();
            }}
          >
            Remove link
          </Button>
        ) : null}
        <Button type="button" variant="outline" className="h-10 px-4" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" className="h-10 px-4">
          Apply
        </Button>
      </DialogFooter>
    </form>
  );
}
