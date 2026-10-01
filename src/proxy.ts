import { NextResponse, type NextRequest } from "next/server";
import { assignRequestId, REQUEST_ID_HEADER } from "@/platform/observability/request-id";
import { decideRoute, normalizeHost } from "@/platform/routing/hosts";

/**
 * proxy.ts (Next 16's middleware, Node runtime), plan §19–20, ADR 0006:
 * site routing (`/s/{address}` always; tenant hosts when HOST_ROUTING_ENABLED),
 * request ID, internal-path guards, and per-surface framing headers.
 * Decisions live in platform/routing/hosts.ts (unit tested).
 *
 * Deferred: the admin cookie-presence redirect (UX only) arrives with the
 * login page in M2-2; script-src CSP in M12-1.
 */

let routing: { appHost: string | null; hostRouting: boolean; sitesRootDomain: string | null } | undefined;
function routingConfig() {
  if (!routing) {
    let appHost: string | null = null;
    try {
      appHost = normalizeHost(new URL(process.env.APP_ORIGIN ?? "").host);
    } catch {
      // not configured: only matters in host mode
    }
    routing = {
      appHost,
      hostRouting: process.env.HOST_ROUTING_ENABLED === "true",
      sitesRootDomain: normalizeHost(process.env.SITES_ROOT_DOMAIN),
    };
  }
  return routing;
}

/**
 * Admin and public site pages can share one origin (V1), so framing is
 * decided per surface: the admin is never framed; site pages only by the
 * admin's own preview pane. No plugins, no <base> hijacking anywhere.
 */
const SURFACE_HEADERS = {
  app: { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
  site: { "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
} as const;

export function proxy(request: NextRequest) {
  const requestId = assignRequestId(request.headers);
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);

  const decision = decideRoute({
    host: normalizeHost(request.headers.get("host")),
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    nextAction: request.headers.has("next-action"),
    overrideAllowed: process.env.VERCEL_ENV !== "production",
    ...routingConfig(),
  });

  let response: NextResponse;
  switch (decision.kind) {
    case "app":
      response = NextResponse.next({ request: { headers } });
      for (const [k, v] of Object.entries(SURFACE_HEADERS.app)) response.headers.set(k, v);
      break;
    case "site":
      response = NextResponse.rewrite(new URL(decision.rewrite, request.url), { request: { headers } });
      for (const [k, v] of Object.entries(SURFACE_HEADERS.site)) response.headers.set(k, v);
      break;
    case "not-found":
      response = new NextResponse("Not found", { status: 404, headers: { "content-type": "text/plain" } });
      break;
    case "unavailable":
      response = new NextResponse("Service unavailable", { status: 503, headers: { "content-type": "text/plain" } });
      break;
  }
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  // Everything except build assets, which are identical for every route.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
