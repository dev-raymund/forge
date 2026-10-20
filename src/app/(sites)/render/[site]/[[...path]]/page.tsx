import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  JsonLd, publicPageFor, publicPageSeo, publicPageTitle, PublicPageView, publicSiteFor, publicStructuredData, renderableSite, renderStateFor, robotsFor, seoMetadata,
} from "@/modules/rendering";
import { BUILD_PLACEHOLDER_SITE, decodeSiteLocator } from "@/platform/routing/hosts";
import { themeFor } from "@/themes/render";

/**
 * Every page of a tenant site (M4-3, ADR 0013; M5-6). The site's status and the path decide what is drawn, before
 * anything streams, so the 404s are real 404 statuses:
 *
 *   coming soon            the theme's coming-soon page, at every path, noindex
 *   live, a path it has    the published page or post, the blog index or an archive, in the theme's template
 *                          (`/` with no published Home page: the site's name and tagline)
 *   anything else          notFound(): ./not-found.tsx answers, with the theme or the platform
 */

// With Cache Components, reading params outside <Suspense> requires static
// params for every dynamic segment; unknown sites and paths then render on
// demand before anything streams (ADR 0002).
export function generateStaticParams() {
  return [{ path: [] }];
}

type Props = PageProps<"/render/[site]/[[...path]]">;

async function stateOf({ params }: Pick<Props, "params">) {
  const { site: segment, path } = await params;
  if (decodeURIComponent(segment) === BUILD_PLACEHOLDER_SITE) return null; // build-time placeholder: no database access
  const locator = decodeSiteLocator(segment);
  const site = locator ? await publicSiteFor(locator) : null;
  const status = renderStateFor(site);
  // Only a live site's paths are looked up: a coming-soon site shows nothing of its content at any path.
  const page = status.kind === "live" ? await publicPageFor(site!, path ?? []) : null;
  const state = status.kind === "live" && !page ? { kind: "page-not-found" as const } : status;
  return { locator, site, state, page };
}

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const resolved = await stateOf({ params });
  if (!resolved) return {};
  const { locator, site, state, page } = resolved;
  // The site's favicon (M6-4), on the pages its theme draws: a 32 px PNG and the 180 px Apple touch icon, from /media.
  const favicon = state.kind === "live" || state.kind === "coming-soon" ? site!.imagery.favicon : null;
  const icons: Metadata = favicon
    ? { icons: { icon: [{ url: favicon.url32, sizes: "32x32", type: "image/png" }], apple: [{ url: favicon.url180, sizes: "180x180", type: "image/png" }] } }
    : {};
  // A live page (M8-4): its resolved SEO, title to structured data.
  if (state.kind === "live" && page) return { ...seoMetadata(publicPageSeo(site!, locator!, page), site!), ...icons };
  // A site's name only where its theme draws the page; never on the platform's answers.
  const title =
    state.kind === "site-not-found" ? "Site not found" : state.kind === "site-unavailable" ? "Site unavailable" : state.kind === "coming-soon" ? site!.name : publicPageTitle(page, site!);
  return { title: { absolute: title }, robots: robotsFor(state.kind), ...icons };
}

export default async function SitePage({ params }: Props) {
  const resolved = await stateOf({ params });
  if (!resolved) return null;
  const { locator, site, state, page } = resolved;
  if (state.kind === "coming-soon") {
    const { theme, context } = themeFor(renderableSite(site!, locator!));
    const ComingSoon = theme.templates["coming-soon"];
    return <ComingSoon context={context} />;
  }
  if (state.kind !== "live" || !page) notFound();
  const data = await publicStructuredData(site!, locator!, page, publicPageSeo(site!, locator!, page));
  return (
    <>
      <JsonLd data={data} />
      <PublicPageView page={page} site={site!} locator={locator!} />
    </>
  );
}
