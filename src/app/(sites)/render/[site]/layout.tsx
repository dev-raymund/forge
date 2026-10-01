import { BUILD_PLACEHOLDER_SITE } from "@/platform/routing/hosts";

/**
 * Root layout #2: every tenant site (D-37). Reached only through the proxy
 * rewrite to /render/{site-locator}/… (`/s/{address}` in V1, tenant hosts
 * later); direct requests to /render/* are rejected by proxy.ts. Theme <html>,
 * tokens and site resolution arrive in M4-3/M4-4.
 *
 * Never reads cookies or the session: public pages are identical for every
 * visitor (cacheable) and never act as the admin, even on the shared V1 origin
 * (ADR 0006; lint forbids modules/auth under (sites)/).
 */

// Cache Components requires at least one value for each root param at build
// time. Real sites are unknown until requested, so a placeholder satisfies the
// build and every real site renders on demand (ADR 0002).
export function generateStaticParams() {
  return [{ site: BUILD_PLACEHOLDER_SITE }];
}

export default function SiteRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-surface="site">
      <body>{children}</body>
    </html>
  );
}
