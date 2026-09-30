/**
 * Host classification and request routing for `proxy.ts` (plan §20, D-02).
 * Pure: no Next.js, no env access, so the decision table is unit tested.
 *
 * The proxy is NOT a security boundary for tenant data (RLS and services are).
 * It is where hosts are normalised, surfaces are separated, and internal paths
 * are kept internal.
 */

export const RENDER_PREFIX = "/render";
/** The one `[host]` value generateStaticParams returns (Cache Components needs one at build). */
export const BUILD_PLACEHOLDER_HOST = "__placeholder";
export const HOST_OVERRIDE_PARAM = "__host";

/**
 * Lowercase, strip port and trailing dot, IDN → punycode (WHATWG URL does the
 * conversion). Returns null for anything that is not a plain hostname.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const candidate = raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!candidate || candidate.length > 253 || /[\s/?#@\\]/.test(candidate)) return null;
  try {
    const { hostname } = new URL(`http://${candidate}`);
    if (hostname.startsWith("[")) return null; // IPv6 literals are never tenant hosts
    return hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

export type RouteInput = {
  host: string | null;
  pathname: string;
  search: string;
  /** Present on Server Action requests. */
  nextAction: boolean;
  /** Normalised host of APP_ORIGIN; null when not configured. */
  appHost: string | null;
  /** `?__host=` is honoured only outside production. */
  overrideAllowed: boolean;
};

export type RouteDecision =
  | { kind: "app" }
  | { kind: "site"; host: string; rewrite: string }
  | { kind: "not-found"; reason: "render-path" | "action-on-site-host" | "bad-host" }
  | { kind: "unavailable"; reason: "app-host-not-configured" };

const HEALTH = /^\/api\/health(\/|$)/;

export function decideRoute(input: RouteInput): RouteDecision {
  // Internal renderer paths are reachable only through the rewrite below.
  if (input.pathname === RENDER_PREFIX || input.pathname.startsWith(`${RENDER_PREFIX}/`)) {
    return { kind: "not-found", reason: "render-path" };
  }

  if (!input.appHost) {
    // Misconfigured: keep health answering (readiness reports the bad env group).
    return HEALTH.test(input.pathname) ? { kind: "app" } : { kind: "unavailable", reason: "app-host-not-configured" };
  }

  let host = input.host;
  let search = input.search;
  if (input.overrideAllowed) {
    const params = new URLSearchParams(input.search);
    const override = params.get(HOST_OVERRIDE_PARAM);
    if (override !== null) {
      const normalized = normalizeHost(override);
      if (!normalized) return { kind: "not-found", reason: "bad-host" };
      host = normalized;
      params.delete(HOST_OVERRIDE_PARAM);
      const rest = params.toString();
      search = rest ? `?${rest}` : "";
    }
  }

  if (!host) return { kind: "not-found", reason: "bad-host" };
  if (host === input.appHost) return { kind: "app" };

  // Tenant site host (subdomain or custom domain; unknown hosts get the
  // platform 404 from the renderer). Admin Server Actions never run here.
  if (input.nextAction) return { kind: "not-found", reason: "action-on-site-host" };
  const path = input.pathname === "/" ? "" : input.pathname;
  return { kind: "site", host, rewrite: `${RENDER_PREFIX}/${encodeURIComponent(host)}${path}${search}` };
}
