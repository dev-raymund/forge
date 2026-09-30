import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { publishTaglineAction } from "@spikes/rendering/actions";
import { listSpikeSites } from "@spikes/rendering/admin";

/**
 * Manual/E2E page for the caching spike (M0-4, ADR 0002). Also the admin
 * pattern under Cache Components: a static shell, with request-time data
 * streamed inside <Suspense>. Never served on Vercel production.
 */
export const metadata: Metadata = { title: "Cache spike" };

export default function CacheSpikePage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-xl font-semibold">Cache spike (S1)</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Publishing runs a Server Action that writes the tagline and calls <code>updateTag</code> for the site&apos;s
        config tag.
      </p>
      <Suspense fallback={<p>Loading sites…</p>}>
        <SiteList />
      </Suspense>
    </main>
  );
}

async function SiteList() {
  await connection(); // request-time data: in the real admin this is the session + tenant context
  const sites = await listSpikeSites();
  if (!sites.length) return <p>No sites yet.</p>;
  return (
    <ul className="grid gap-3">
      {sites.map((site) => (
        <li key={site.siteId} className="rounded-md border p-3" data-host={site.host}>
          <form action={publishTaglineAction} className="flex flex-wrap items-center gap-2">
            <code className="text-sm">{site.host}</code>
            <input type="hidden" name="orgId" value={site.orgId} />
            <input type="hidden" name="siteId" value={site.siteId} />
            <input name="tagline" aria-label={`Tagline for ${site.host}`} className="rounded border px-2 py-1" required />
            <button type="submit" className="rounded border px-2 py-1">
              Publish
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
