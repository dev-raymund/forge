"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { ENTRY_SEARCH_PATH } from "@/modules/content/shared";
import { IDLE, type FormState } from "@/platform/forms";
import { setNotFoundPageAction } from "../actions";

/**
 * The site's not-found page (M8-5, plan §10 "custom 404 page setting"): a published page of the site, shown with a
 * real 404 status at every address the site does not have; or the theme's own not-found page. Chosen by searching the
 * site's pages (the editor's link search, M5-4); only published pages, not the Home page, can be chosen, and the
 * server checks that again.
 */

const INPUT =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 md:text-sm";

type EntryMatch = { id: string; type: string; title: string; path: string; status: string };

function usePageSearch(orgSlug: string, siteSlug: string, query: string) {
  const [results, setResults] = useState<EntryMatch[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ org: orgSlug, site: siteSlug, q: query });
        const response = await fetch(`${ENTRY_SEARCH_PATH}?${params}`, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        setResults(((await response.json()) as { entries: EntryMatch[] }).entries);
        setFailed(false);
      } catch (cause) {
        if ((cause as Error).name !== "AbortError") setFailed(true);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [orgSlug, siteSlug, query]);
  return { results: query.trim() ? results : null, failed };
}

export function NotFoundPageForm({
  orgSlug, siteSlug, current,
}: { orgSlug: string; siteSlug: string; current: { id: string; title: string; path: string; live: boolean } | null }) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const { results, failed } = usePageSearch(orgSlug, siteSlug, query);
  const choices = (results ?? []).filter((entry) => entry.type === "page" && entry.status === "published" && entry.path !== "/");

  async function choose(entryId: string) {
    setPending(true);
    setNotice(null);
    try {
      const data = new FormData();
      data.set("entryId", entryId);
      const result: FormState = await setNotFoundPageAction(orgSlug, siteSlug, IDLE, data);
      if (result.status === "success") {
        setNotice({ tone: "success", text: result.message ?? "Saved." });
        setQuery("");
      } else setNotice({ tone: "error", text: result.message ?? Object.values(result.fieldErrors ?? {}).flat()[0] ?? "Not saved." });
    } catch {
      setNotice({ tone: "error", text: "Not saved: the connection failed. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4" data-testid="not-found-page">
      <div className="grid gap-1">
        <p className="text-sm font-medium">Shown now</p>
        {current ? (
          <p className="text-sm" data-testid="not-found-current">
            {current.title || "Untitled"} <span className="text-muted-foreground">({current.path})</span>
          </p>
        ) : (
          <p className="text-sm" data-testid="not-found-current">
            The theme&rsquo;s own not-found page.
          </p>
        )}
        {current && !current.live ? (
          <p className="flex items-start gap-1.5 text-sm text-amber-800">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            It is not published now, so the site shows the theme&rsquo;s not-found page until it is.
          </p>
        ) : null}
      </div>
      <div className="grid gap-1">
        <label htmlFor={searchId} className="text-sm font-medium">
          Use another page
        </label>
        <input
          id={searchId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the site's pages"
          autoComplete="off"
          aria-describedby={`${searchId}-hint`}
          className={INPUT}
        />
        <p id={`${searchId}-hint`} className="text-xs text-muted-foreground">
          A published page (not the home page). It keeps its own address too: mark it noindex in its SEO tab to keep it out of search results.
        </p>
      </div>
      {failed ? <p className="text-sm text-destructive">The pages could not be searched. Try again.</p> : null}
      {results ? (
        choices.length ? (
          <ul className="grid gap-2" aria-label="Pages found">
            {choices.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
                <span className="min-w-0 text-sm wrap-anywhere">
                  {entry.title || "Untitled"} <span className="text-muted-foreground">({entry.path})</span>
                </span>
                <Button type="button" variant="outline" className="h-9 px-3" disabled={pending} onClick={() => void choose(entry.id)}>
                  Use {entry.title || "this page"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No published page matches.</p>
        )
      ) : null}
      {current ? (
        <Button type="button" variant="ghost" className="h-9 justify-self-start px-3" disabled={pending} onClick={() => void choose("")}>
          Use the theme&rsquo;s not-found page
        </Button>
      ) : null}
      <div aria-live="polite" className="empty:hidden">
        {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
      </div>
    </div>
  );
}
