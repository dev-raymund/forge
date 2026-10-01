import { notFound } from "next/navigation";
import { getSiteView, resolveSite } from "@spikes/rendering/queries";
import { BUILD_PLACEHOLDER_SITE, decodeSiteLocator, siteBasePath } from "@/platform/routing/hosts";

/**
 * Site renderer entry (reached only through the proxy rewrite). For now it
 * renders the spike view from M0-4 (ADR 0002); M4-3/M5-6 replace it with
 * route resolution and theme templates.
 *
 * The site is resolved before anything streams, so an unknown site gets a real
 * 404 status. How the site was addressed (path or host) only changes the
 * lookup and the base path for links (ADR 0006).
 */

// With Cache Components, reading params outside <Suspense> requires static
// params for every dynamic segment; unknown sites and paths then render on
// demand before anything streams (ADR 0002).
export function generateStaticParams() {
  return [{ path: [] }];
}

export default async function SitePage({ params }: PageProps<"/render/[site]/[[...path]]">) {
  const { site: segment, path } = await params;
  if (decodeURIComponent(segment) === BUILD_PLACEHOLDER_SITE) return null; // build-time placeholder: no database access

  const locator = decodeSiteLocator(segment);
  if (!locator) notFound();
  const site = await resolveSite(locator);
  if (!site) notFound();
  const view = await getSiteView(site.orgId, site.siteId);
  if (!view) notFound();
  const base = siteBasePath(locator);

  return (
    <main>
      <h1 data-testid="site-name">
        <a href={base || "/"}>{view.name}</a>
      </h1>
      <p data-testid="tagline">{view.tagline}</p>
      <p>
        <small>
          path <code data-testid="path">/{(path ?? []).join("/")}</code> · base <code data-testid="base-path">{base}</code> ·
          data cached at <time data-testid="rendered-at">{view.renderedAt}</time>
        </small>
      </p>
    </main>
  );
}
