/**
 * The session cookie, as far as code outside Better Auth needs to know it
 * (the proxy, M2-2). Pure and client-safe. `tests/integration/auth.test.ts`
 * checks these against the cookie Better Auth really sets.
 */

export const SESSION_COOKIE = "better-auth.session_token";
/** On https Better Auth adds the `__Secure-` prefix. */
export const SECURE_SESSION_COOKIE = `__Secure-${SESSION_COOKIE}`;
/** Plan §12: the idle window. Also the cookie's Max-Age. */
export const SESSION_IDLE_SECONDS = 7 * 24 * 3600;

export type SessionCookie = { name: string; rawValue: string };

// RFC 6265 cookie-octet: nothing that could end the value or start another header.
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

/**
 * The session cookie in a `Cookie` header, exactly as the browser sent it.
 * Its presence proves nothing: only `resolveAuth()` decides whether the
 * session is valid.
 */
export function findSessionCookie(cookieHeader: string | null | undefined): SessionCookie | null {
  if (!cookieHeader) return null;
  let plain: SessionCookie | null = null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const rawValue = part.slice(eq + 1).trim();
    if (!COOKIE_VALUE.test(rawValue)) continue;
    if (name === SECURE_SESSION_COOKIE) return { name, rawValue };
    if (name === SESSION_COOKIE) plain ??= { name, rawValue };
  }
  return plain;
}

/**
 * A `Set-Cookie` that renews the browser cookie's lifetime without touching its
 * value, with the attributes Better Auth sets. The server-side session is what
 * expires (7 days idle, 30 days absolute); this only keeps the browser from
 * dropping the cookie of a session that is still alive.
 */
export function renewedSessionCookie(cookie: SessionCookie): string {
  const secure = cookie.name.startsWith("__Secure-") ? "; Secure" : "";
  return `${cookie.name}=${cookie.rawValue}; Max-Age=${SESSION_IDLE_SECONDS}; Path=/; HttpOnly${secure}; SameSite=Lax`;
}
