"use client";

import dynamic from "next/dynamic";

/**
 * The editor is client-only and loaded lazily. Under Cache Components it must
 * be: Tiptap generates random ids during render, which prerendering rejects.
 */
export const EditorSpikeLazy = dynamic(() => import("./editor").then((m) => m.EditorSpike), {
  ssr: false,
  loading: () => <p>Loading editor…</p>,
});
