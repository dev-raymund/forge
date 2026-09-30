import type { Metadata } from "next";
import "./globals.css";

/**
 * Root layout #1: the admin app on the app host (D-37).
 * Tenant sites have their own root layout under (sites)/render/[host], so no
 * admin CSS or JS ever ships to a public site.
 */
export const metadata: Metadata = {
  title: { default: "Forge", template: "%s · Forge" },
  robots: { index: false, follow: false },
};

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-surface lets instrumentation-client.ts load Sentry on the admin only.
    <html lang="en" data-surface="admin">
      <body className="min-h-dvh bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
