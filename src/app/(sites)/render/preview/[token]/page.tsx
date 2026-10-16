import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { loadPreview, PreviewUnavailable, PreviewView } from "@/modules/rendering";

/**
 * A preview of a draft or of a revision (M7-4; plan §9 "Preview"; ADR 0027), drawn by the site's theme for the person
 * the token names. Never prerendered and never cached: everything private is read when it is requested (`connection()`),
 * and the proxy has already sent `Cache-Control: private, no-store`, `X-Robots-Tag: noindex` and framing for the
 * admin only. A token the proxy let through that is no good now (its person removed or demoted, its entry trashed) gets
 * the same answer as one for nothing.
 */

export const metadata: Metadata = { title: "Preview", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function PreviewPage({ params }: PageProps<"/render/preview/[token]">) {
  return (
    <Suspense fallback={null}>
      <Preview params={params} />
    </Suspense>
  );
}

async function Preview({ params }: Pick<PageProps<"/render/preview/[token]">, "params">) {
  await connection();
  const { token } = await params;
  const preview = await loadPreview(token);
  if (!preview) return <PreviewUnavailable />;
  return <PreviewView preview={preview} />;
}
