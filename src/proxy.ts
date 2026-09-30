import { NextResponse, type NextRequest } from "next/server";
import { assignRequestId, REQUEST_ID_HEADER } from "@/platform/observability/request-id";
import { decideRoute, normalizeHost } from "@/platform/routing/hosts";

/**
 * proxy.ts (Next 16's middleware, Node runtime), plan §20:
 * host routing · request ID · reserved-path guards.
 * Decisions live in platform/routing/hosts.ts (unit tested).
 *
 * Deferred: the admin cookie-presence redirect (UX only) arrives with the
 * login page in M2-2; security headers per surface in M12-1.
 */

let appHost: string | null | undefined;
function configuredAppHost(): string | null {
  if (appHost === undefined) {
    try {
      appHost = normalizeHost(new URL(process.env.APP_ORIGIN ?? "").host);
    } catch {
      appHost = null;
    }
  }
  return appHost;
}

export function proxy(request: NextRequest) {
  const requestId = assignRequestId(request.headers);
  const headers = new Headers(request.headers);
  headers.set(REQUEST_ID_HEADER, requestId);

  const decision = decideRoute({
    host: normalizeHost(request.headers.get("host")),
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    nextAction: request.headers.has("next-action"),
    appHost: configuredAppHost(),
    overrideAllowed: process.env.VERCEL_ENV !== "production",
  });

  let response: NextResponse;
  switch (decision.kind) {
    case "app":
      response = NextResponse.next({ request: { headers } });
      break;
    case "site":
      response = NextResponse.rewrite(new URL(decision.rewrite, request.url), { request: { headers } });
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
  // Everything except build assets, which are identical for every host.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
