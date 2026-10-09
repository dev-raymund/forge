import type { Metadata } from "next";

/**
 * Root layout of the theme gallery (M4-4): a development page, never served in
 * production (like /dev/editor). Its own root, so no admin CSS reaches a
 * theme, as on a real site (D-37).
 */
export const metadata: Metadata = { title: "Theme gallery", robots: { index: false, follow: false } };

export default function ThemeGalleryLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-surface="site">
      <body>{children}</body>
    </html>
  );
}
