"use client";

import { useEffect, useState } from "react";
import { ENTRY_SEARCH_PATH } from "../admin-paths";
import type { ContentTypeKey } from "../types/definition";

/**
 * The site's pages and posts matching a title, from `/api/app/entries/search`
 * (M5-4), a quarter of a second after the last key: for the link dialog and
 * a button block's link (M5-5). The server answers for the site named and
 * only to its members.
 */
export type EntryMatch = { id: string; type: ContentTypeKey; title: string; path: string; status: string };

export function useEntrySearch(orgSlug: string, siteSlug: string, query: string, enabled = true): { results: EntryMatch[] | null; failed: boolean } {
  const [results, setResults] = useState<EntryMatch[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
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
  }, [orgSlug, siteSlug, query, enabled]);
  return { results, failed };
}
