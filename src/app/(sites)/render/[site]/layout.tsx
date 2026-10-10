import { emitsAnalytics, htmlLang, isShowable, publicSiteFor, rememberRequestSite, renderableSite, SiteAnalytics } from "@/modules/rendering";
import { BUILD_PLACEHOLDER_SITE, decodeSiteLocator } from "@/platform/routing/hosts";
import { themeFor } from "@/themes/render";

/**
 * Root layout #2: every tenant site (D-37), reached only through the proxy's
 * rewrite of `/s/{address}/…` (and, post-V1, of a site's own host) to
 * `/render/{locator}/…`. Direct requests to `/render/*` are refused by the proxy.
 *
 * The site is resolved here, from the address in the URL and nothing else
 * (M4-3, ADR 0013), before anything streams. A site its theme may draw
 * (coming soon or live) gets the theme's frame: header, footer, fonts and its
 * settings as CSS variables. An unknown or unavailable site gets a bare page,
 * filled in by `not-found.tsx` with the platform's answer.
 *
 * Never reads cookies or the session: public pages are the same for every
 * visitor, and never act as the admin, even on the shared V1 origin (ADR 0006;
 * lint forbids modules/auth under (sites)/).
 */

// Cache Components requires at least one value for each root param at build
// time. Real sites are unknown until requested, so a placeholder satisfies the
// build and every real site renders on demand (ADR 0002).
export function generateStaticParams() {
  return [{ site: BUILD_PLACEHOLDER_SITE }];
}

export default async function SiteRootLayout({ children, params }: LayoutProps<"/render/[site]">) {
  const { site: segment } = await params;
  // The build-time placeholder: no database at build (ADR 0002).
  if (decodeURIComponent(segment) === BUILD_PLACEHOLDER_SITE) return <Bare lang="en">{children}</Bare>;

  const locator = decodeSiteLocator(segment);
  const site = locator ? await publicSiteFor(locator) : null;
  if (locator) rememberRequestSite(locator, site);
  if (!locator || !site || !isShowable(site)) return <Bare lang={htmlLang(site)}>{children}</Bare>;

  const { theme, context } = themeFor(renderableSite(site, locator));
  const { Layout } = theme;
  return (
    <Bare lang={htmlLang(site)}>
      <Layout context={context}>{children}</Layout>
      {/* Never, for now (M4-5, ADR 0015 §6): tracking waits for a consent decision. Then only on live sites (M4-2). */}
      {emitsAnalytics(site.status) ? <SiteAnalytics analytics={site.analytics} /> : null}
    </Bare>
  );
}

function Bare({ lang, children }: { lang: string; children: React.ReactNode }) {
  return (
    <html lang={lang} data-surface="site">
      <body>{children}</body>
    </html>
  );
}
