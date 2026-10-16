/**
 * Root layout #3 (M7-4): previews, reached only through the proxy's rewrite of `/_forge/preview/{token}` after it has
 * checked the token (direct requests to `/render/*` are refused). Like the site tree, it never reads cookies or the
 * session: the token says whose preview it is. The page draws the site's theme itself, once it has checked the token
 * again and read what it shows, which happens at request time only.
 */
export default function PreviewRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-surface="site">
      <body>{children}</body>
    </html>
  );
}
