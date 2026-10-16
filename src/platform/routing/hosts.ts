/**
 * Request routing for `proxy.ts` (plan §19–20, ADR 0002, ADR 0006).
 * Pure: no Next.js, no env access, so the decision table is unit tested.
 *
 * Two ways to address a tenant site, one renderer:
 *  - **path mode** (V1 deployment, always on): `/s/{address}/…` on any host.
 *    `{address}` is the site's platform address label (`domains` row of kind
 *    `subdomain`, globally unique).
 *  - **host mode** (post-V1, `HOST_ROUTING_ENABLED`): every host other than the
 *    app host is a tenant site (`{address}.{SITES_ROOT_DOMAIN}` or a custom domain).
 *
 * The proxy is NOT a security boundary for tenant data (RLS and services are).
 * It separates the admin from public site pages and keeps internal paths internal.
 */

export const RENDER_PREFIX = "/render";
export const SITE_PATH_PREFIX = "/s";
export const MEDIA_PREFIX = "/media";
/** The one `[site]` value generateStaticParams returns (Cache Components needs one at build). */
export const BUILD_PLACEHOLDER_SITE = "__placeholder";
export const HOST_OVERRIDE_PARAM = "__host";
/** M7-4: `/_forge/preview/{token}` (ADR 0006), rewritten to this internal route; `/_forge/…` is otherwise nothing. */
export const FORGE_PREFIX = "/_forge";
export const PREVIEW_PATH_PREFIX = `${FORGE_PREFIX}/preview`;
export const PREVIEW_RENDER_PREFIX = `${RENDER_PREFIX}/preview`;
/** base64url payload, a dot, base64url signature (./preview-token.ts): the only shape a token has. */
export const PREVIEW_TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,1000}\.[A-Za-z0-9_-]{43}$/;

/** A site's platform address: a DNS-label-shaped slug, so it can become `{address}.sites.example.com` later. */
const ADDRESS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const isSiteAddress = (value: string) => ADDRESS.test(value) && !value.includes("--");

// ── Site locators: how the internal renderer route identifies a site ─────────

export type SiteLocator = { kind: "address"; address: string } | { kind: "host"; hostname: string };

/** `/render/{locator}/…` segment: `address~acme` or `host~client.com` (`~` never occurs in either). */
export function encodeSiteLocator(locator: SiteLocator): string {
  return locator.kind === "address" ? `address~${locator.address}` : `host~${locator.hostname}`;
}

export function decodeSiteLocator(segment: string): SiteLocator | null {
  const [kind, value, extra] = decodeURIComponent(segment).split("~");
  if (extra !== undefined || !value) return null;
  if (kind === "address") return isSiteAddress(value) ? { kind, address: value } : null;
  if (kind === "host") {
    const hostname = normalizeHost(value);
    return hostname ? { kind, hostname } : null;
  }
  return null;
}

/** Where a site's public pages live, for links, canonical URLs and sitemaps. */
export function siteBasePath(locator: SiteLocator): string {
  return locator.kind === "address" ? `${SITE_PATH_PREFIX}/${locator.address}` : "";
}

// ── Hosts ────────────────────────────────────────────────────────────────────

/**
 * Lowercase, strip port and trailing dot, IDN → punycode (WHATWG URL does the
 * conversion). Returns null for anything that is not a plain hostname.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const candidate = raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!candidate || candidate.length > 253 || /[\s/?#@\\~]/.test(candidate)) return null;
  try {
    const { hostname } = new URL(`http://${candidate}`);
    if (hostname.startsWith("[")) return null; // IPv6 literals are never tenant hosts
    return hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** In host mode: `{address}.{sitesRootDomain}` → address locator; any other host → custom-domain locator. */
export function locatorForHost(host: string, sitesRootDomain: string | null): SiteLocator {
  if (sitesRootDomain && host.endsWith(`.${sitesRootDomain}`)) {
    const address = host.slice(0, -(sitesRootDomain.length + 1));
    if (isSiteAddress(address)) return { kind: "address", address };
  }
  return { kind: "host", hostname: host };
}

// ── The decision ─────────────────────────────────────────────────────────────

export type RouteInput = {
  host: string | null;
  pathname: string;
  search: string;
  /** Present on Server Action requests. */
  nextAction: boolean;
  /** Normalised host of APP_ORIGIN; needed only in host mode. */
  appHost: string | null;
  /** Post-V1: tenant sites on their own hosts. Off in the V1 deployment. */
  hostRouting: boolean;
  /** Host mode only: the root under which `{address}.{root}` hosts live. */
  sitesRootDomain: string | null;
  /** `?__host=` (host mode only) is honoured only outside production. */
  overrideAllowed: boolean;
};

export type RouteDecision =
  | { kind: "app" }
  /** `/media/{key}` (M6-2): public objects, the same for everyone; credentials never reach it, and none are set. */
  | { kind: "media" }
  | { kind: "site"; locator: SiteLocator; rewrite: string }
  /**
   * `/_forge/preview/{token}` (M7-4) on the app host: a draft or a revision, drawn like a site page for the person the
   * token names. The proxy checks the token's signature and expiry before rewriting; the renderer checks it again.
   */
  | { kind: "preview"; token: string; rewrite: string }
  | { kind: "not-found"; reason: "render-path" | "action-on-site" | "bad-host" | "bad-address" | "bad-preview" }
  | { kind: "unavailable"; reason: "app-host-not-configured" };

const HEALTH = /^\/api\/health(\/|$)/;

function site(locator: SiteLocator, rest: string, search: string, nextAction: boolean): RouteDecision {
  // Public site pages are read-only: admin Server Actions never run on them.
  if (nextAction) return { kind: "not-found", reason: "action-on-site" };
  const path = rest === "/" ? "" : rest;
  return { kind: "site", locator, rewrite: `${RENDER_PREFIX}/${encodeSiteLocator(locator)}${path}${search}` };
}

export function decideRoute(input: RouteInput): RouteDecision {
  // Internal renderer paths are reachable only through the rewrites below.
  if (input.pathname === RENDER_PREFIX || input.pathname.startsWith(`${RENDER_PREFIX}/`)) {
    return { kind: "not-found", reason: "render-path" };
  }

  if (input.hostRouting) {
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
    if (host !== input.appHost) {
      return site(locatorForHost(host, input.sitesRootDomain), input.pathname, search, input.nextAction);
    }
  }

  // Path mode (always available on the app host): /s/{address}/…
  if (input.pathname === SITE_PATH_PREFIX || input.pathname.startsWith(`${SITE_PATH_PREFIX}/`)) {
    const [, , address = "", ...rest] = input.pathname.split("/");
    if (!isSiteAddress(address)) return { kind: "not-found", reason: "bad-address" };
    return site({ kind: "address", address }, `/${rest.join("/")}`, input.search, input.nextAction);
  }

  if (input.pathname === MEDIA_PREFIX || input.pathname.startsWith(`${MEDIA_PREFIX}/`)) return { kind: "media" };

  // Previews (M7-4): only on the app host (in host mode, a tenant's host never reaches here). Read-only, like site pages.
  if (input.pathname === FORGE_PREFIX || input.pathname.startsWith(`${FORGE_PREFIX}/`)) {
    const token = input.pathname.startsWith(`${PREVIEW_PATH_PREFIX}/`) ? input.pathname.slice(PREVIEW_PATH_PREFIX.length + 1) : "";
    if (!PREVIEW_TOKEN_SHAPE.test(token)) return { kind: "not-found", reason: "bad-preview" };
    if (input.nextAction) return { kind: "not-found", reason: "action-on-site" };
    return { kind: "preview", token, rewrite: `${PREVIEW_RENDER_PREFIX}/${token}` };
  }

  return { kind: "app" };
}

// ── Headers forwarded to the app ─────────────────────────────────────────────

/**
 * Credentials never reach public site rendering. Admin and sites share one
 * origin in V1, so the browser sends the admin session cookie with `/s/…`
 * requests too; the proxy removes it (and any Authorization header) before
 * the renderer runs. Site pages therefore cannot act as, or vary by, the
 * signed-in admin, whatever the rendering code does (ADR 0006). Media
 * (`/media/…`, M6-2) is served the same way: public, cached, the same for
 * every visitor. So are previews (M7-4): their token, not a session, says who may see them.
 */
export const SITE_STRIPPED_HEADERS = ["cookie", "authorization"] as const;

export function forwardedHeaders(incoming: Headers, decision: RouteDecision, requestId: string, requestIdHeader: string): Headers {
  const headers = new Headers(incoming);
  headers.set(requestIdHeader, requestId);
  if (decision.kind === "site" || decision.kind === "media" || decision.kind === "preview") for (const name of SITE_STRIPPED_HEADERS) headers.delete(name);
  return headers;
}
