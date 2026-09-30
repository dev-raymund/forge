import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EditorSpikeLazy } from "@spikes/editor/editor-lazy";

/** Manual test page for the editor spike (M0-5, ADR 0003). Never served in production. */

export const metadata: Metadata = { title: "Editor spike" };

export default function EditorSpikePage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-7xl p-6">
      <h1 className="mb-4 text-xl font-semibold">Editor spike (S3)</h1>
      <EditorSpikeLazy />
    </main>
  );
}
