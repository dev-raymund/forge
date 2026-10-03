import "server-only";
import { AUTH_BASE_PATH, getAuth } from "./auth";

/**
 * How Forge's own forms reach Better Auth (M2-2): through the same request
 * handler as `/api/auth/*`, not through `auth.api.*`.
 *
 * Calling `auth.api.*` directly would skip everything Better Auth does per
 * request: the rate limiter, the origin and CSRF checks, the captcha plugin and
 * the disabled-path list. Going through the handler means a Server Action and a
 * direct HTTP call are held to exactly the same rules.
 */

/** Request headers Better Auth needs: the session, the caller's origin and address. Nothing else is passed on. */
const FORWARDED = [
  "cookie", "origin", "referer", "user-agent", "x-forwarded-for",
  "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "x-request-id",
] as const;

export type AuthResponse = {
  status: number;
  /** Better Auth's error code, when it gave one. Never shown to users. */
  code?: string;
  body: Record<string, unknown> | null;
  /** `Set-Cookie` values to pass on to the browser. */
  setCookies: string[];
  retryAfterSeconds?: number;
};

export async function callAuth(
  path: `/${string}`,
  requestHeaders: Headers,
  body: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<AuthResponse> {
  const auth = getAuth();
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of FORWARDED) {
    const value = requestHeaders.get(name);
    if (value) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);

  const origin = new URL(auth.options.baseURL!).origin;
  const response = await auth.handler(
    new Request(`${origin}${AUTH_BASE_PATH}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  );

  let parsed: Record<string, unknown> | null = null;
  try {
    const json: unknown = await response.json();
    if (json && typeof json === "object") parsed = json as Record<string, unknown>;
  } catch {
    // no body, or not JSON
  }
  const retryAfter = Number(response.headers.get("x-retry-after") ?? response.headers.get("retry-after"));
  return {
    status: response.status,
    code: typeof parsed?.code === "string" ? parsed.code : undefined,
    body: parsed,
    setCookies: response.headers.getSetCookie(),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
  };
}
