import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

/**
 * Baseline security headers for every surface (admin, tenant sites, API).
 *
 * Carried over from Forgeline's next.config.ts. Deliberately absent here:
 * - X-Frame-Options / frame-ancestors: tenant sites must be frameable by the
 *   admin origin for preview (v1-build-plan §9), while the admin must not be
 *   frameable at all. Those differ per host, so they are set per surface in
 *   proxy.ts (M1-7 / M12-1), not globally.
 * - Content-Security-Policy: the admin gets a nonce-based policy from proxy.ts
 *   in M12-1; tenant sites get a baseline policy there too.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // D-27: Cache Components is the caching model for the site renderer.
  cacheComponents: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

// Source maps are uploaded to Sentry only when SENTRY_AUTH_TOKEN is set (CI on
// Vercel); local and PR builds skip it and make no Sentry network calls.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  telemetry: false,
  silent: !process.env.CI,
});
