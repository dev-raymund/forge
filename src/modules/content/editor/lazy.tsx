"use client";

import dynamic from "next/dynamic";

/**
 * The editor, client-only and loaded when the page needs it (plan §18; ADR 0003
 * gap 5): Tiptap makes random ids while rendering, which prerendering refuses,
 * and its 200 KB stay out of every other admin page.
 */
export const EntryEditorLazy = dynamic(() => import("./entry-editor").then((module) => module.EntryEditor), {
  ssr: false,
  loading: () => (
    <div className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-6 sm:px-6" aria-busy="true" data-testid="editor-loading">
      <div className="h-6 w-40 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-10 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-64 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <span className="sr-only">Loading the editor…</span>
    </div>
  ),
});
