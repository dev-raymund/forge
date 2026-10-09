import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicSiteFor, renderableSite, renderStateFor, robotsFor } from "@/modules/rendering";
import { BUILD_PLACEHOLDER_SITE, decodeSiteLocator } from "@/platform/routing/hosts";
import { themeFor } from "@/themes/render";

/**
 * Every page of a tenant site (M4-3, ADR 0013). The site and the path decide
 * what is drawn (`renderStateFor`), before anything streams, so the 404s are
 * real 404 statuses:
 *
 *   coming soon          the theme's coming-soon page, at every path, noindex
 *   live, the home page  the theme's page template with the site's name (M5-6 brings real pages)
 *   anything else        notFound(): ./not-found.tsx answers, with the theme or the platform
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
  return { locator, site, state: renderStateFor(site, path ?? []) };
}

export async function generateMetadata({ params }: Pick<Props, "params">): Promise<Metadata> {
  const resolved = await stateOf({ params });
  if (!resolved) return {};
  const { site, state } = resolved;
  // A site's name only where its theme draws the page; never on the platform's answers.
  const title = state.kind === "site-not-found" ? "Site not found" : state.kind === "site-unavailable" ? "Site unavailable" : site!.name;
  return { title: { absolute: state.kind === "page-not-found" ? `Page not found · ${site!.name}` : title }, robots: robotsFor(state.kind) };
}

export default async function SitePage({ params }: Props) {
  const resolved = await stateOf({ params });
  if (!resolved) return null;
  const { locator, site, state } = resolved;
  if (state.kind !== "coming-soon" && state.kind !== "home") notFound();

  const { theme, context } = themeFor(renderableSite(site!, locator!));
  if (state.kind === "coming-soon") {
    const ComingSoon = theme.templates["coming-soon"];
    return <ComingSoon context={context} />;
  }
  // A live site's home page until its content exists (M5-6): its name, and its tagline.
  const Page = theme.templates.page;
  return <Page context={context} title={site!.name}>{site!.tagline ? <p>{site!.tagline}</p> : null}</Page>;
}
