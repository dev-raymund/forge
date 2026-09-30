import { notFound } from "next/navigation";
import { getSiteView, resolveSiteByHost } from "@spikes/rendering/queries";
import { BUILD_PLACEHOLDER_HOST } from "@/platform/routing/hosts";

/**
 * Site renderer entry (reached only through the proxy rewrite). For now it
 * renders the spike view from M0-4 (ADR 0002); M4-3/M5-6 replace it with
 * route resolution and theme templates.
 *
 * The host is resolved before anything streams, so an unknown host gets a real
 * 404 status (ADR 0002).
 */
// With Cache Components, reading params outside <Suspense> requires static
// params for every dynamic segment; unknown hosts and paths then render on
// demand before anything streams (ADR 0002).
export function generateStaticParams() {
  return [{ path: [] }];
}

export default async function SitePage({ params }: PageProps<"/render/[host]/[[...path]]">) {
  const { host: rawHost, path } = await params;
  const host = decodeURIComponent(rawHost);
  if (host === BUILD_PLACEHOLDER_HOST) return null; // build-time placeholder: no database access

  const site = await resolveSiteByHost(host);
  if (!site) notFound();
  const view = await getSiteView(site.orgId, site.siteId);
  if (!view) notFound();

  return (
    <main>
      <h1 data-testid="site-name">{view.name}</h1>
      <p data-testid="tagline">{view.tagline}</p>
      <p>
        <small>
          path <code data-testid="path">/{(path ?? []).join("/")}</code> · data cached at{" "}
          <time data-testid="rendered-at">{view.renderedAt}</time>
        </small>
      </p>
    </main>
  );
}
