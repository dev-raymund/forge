/**
 * Root layout #2: every tenant site (D-37). Reached only through the proxy
 * rewrite to /render/{host}/… — direct requests to /render/* are rejected by
 * proxy.ts (M1-7). Theme <html>, tokens and site resolution arrive in M4-3/M4-4.
 */

// Cache Components requires at least one value for each root param at build
// time. Real hosts are unknown until requested, so a placeholder satisfies the
// build and every real host renders on demand (ADR 0002).
export function generateStaticParams() {
  return [{ host: "__placeholder" }];
}

export default function SiteRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
