/**
 * Which admin paths need a session, and where a login may send the user
 * afterwards (plan §19, M2-2). Pure: no Next.js, no env, unit tested.
 *
 * The redirect decided here is a convenience, NOT the security boundary. It
 * looks only at whether a session cookie is present, which proves nothing.
 * Every protected page and every Server Action still calls the auth module's
 * session helpers.
 */

export const LOGIN_PATH = "/login";
export const SIGNED_IN_HOME = "/";

/** Account screens that work without a session. */
export const AUTH_PAGES = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password"] as const;

/**
 * Everything else on the app surface that answers without the login redirect:
 * route handlers authenticate themselves (and must answer 401, not a login
 * page), media and previews are public or token-protected, `/dev` pages guard
 * themselves, `/invite` is the invitation landing page (M3).
 */
const PUBLIC_PREFIXES = [...AUTH_PAGES, "/invite", "/api", "/media", "/_forge", "/_next", "/dev", "/.well-known"];
const PUBLIC_FILES = new Set(["/favicon.ico", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest"]);

/**
 * Places a login never sends the user: the screens for signed-out users (they
 * would bounce straight back), and everything that is not an admin page.
 * Tenant sites (`/s`) are excluded on purpose: on the shared V1 origin a login
 * link must not be able to land a fresh session on tenant-authored content.
 */
const NOT_A_DESTINATION = ["/login", "/signup", "/forgot-password", "/reset-password", "/api", "/s", "/render", "/media", "/_next", "/_forge"];

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export const isAuthPage = (pathname: string) => AUTH_PAGES.some((p) => under(pathname, p));
export const isPublicAppPath = (pathname: string) => PUBLIC_FILES.has(pathname) || PUBLIC_PREFIXES.some((p) => under(pathname, p));

// A base that no real URL shares: anything that resolves elsewhere left the app.
const BASE = "http://forge.invalid";

/**
 * The path to continue to after signing in, from untrusted input (`?next=`, a
 * hidden form field). Only a path on this app is accepted; anything else,
 * including every absolute or protocol-relative URL, becomes `fallback`.
 */
export function safeNextPath(raw: unknown, fallback: string = SIGNED_IN_HOME): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
  // One leading slash only; no backslashes (browsers read them as slashes) and
  // no control characters (browsers strip tabs and newlines before resolving).
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  // "/.//host" normalises to the path "//host", which a browser would treat as another origin.
  if (url.origin !== BASE || url.pathname.startsWith("//")) return fallback;
  if (NOT_A_DESTINATION.some((p) => under(url.pathname, p))) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Why the user is being asked to sign in again; shown as a notice on the login page. */
export const LOGIN_REASONS = ["session", "password-reset", "signed-out"] as const;
export type LoginReason = (typeof LOGIN_REASONS)[number];
export const isLoginReason = (value: unknown): value is LoginReason => LOGIN_REASONS.includes(value as LoginReason);

export function loginPath({ next, reason }: { next?: string; reason?: LoginReason } = {}): string {
  const params = new URLSearchParams();
  const destination = safeNextPath(next);
  if (destination !== SIGNED_IN_HOME) params.set("next", destination);
  if (reason) params.set("reason", reason);
  const query = params.toString();
  return query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}

export type AdminAccessInput = {
  method: string;
  pathname: string;
  search: string;
  /** Presence only. Whether the session is valid is decided by the page. */
  hasSessionCookie: boolean;
  /** Server Action requests authenticate inside the action and answer with a result, not a redirect. */
  nextAction: boolean;
};

export type AdminAccess = { kind: "pass" } | { kind: "login"; location: string };

/** For requests the router already classified as the app surface (never `/s/…`). */
export function decideAdminAccess(input: AdminAccessInput): AdminAccess {
  if (input.method !== "GET" && input.method !== "HEAD") return { kind: "pass" };
  if (input.nextAction || input.hasSessionCookie || isPublicAppPath(input.pathname)) return { kind: "pass" };
  return { kind: "login", location: loginPath({ next: `${input.pathname}${input.search}` }) };
}

/** A full page load (not a client-side transition, prefetch or data request). */
export function isDocumentNavigation(method: string, headers: Headers): boolean {
  if (method !== "GET" || headers.has("rsc") || headers.has("next-router-prefetch")) return false;
  const dest = headers.get("sec-fetch-dest");
  return dest ? dest === "document" : (headers.get("accept") ?? "").includes("text/html");
}
