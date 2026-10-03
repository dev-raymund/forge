import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

/**
 * The real proxy function. Next.js forwards exactly the headers listed in
 * `x-middleware-override-headers` (values in `x-middleware-request-*`), so
 * these assertions are about what the route actually receives.
 */
const cookie = "better-auth.session_token=secret-session-token";
const request = (path: string, init: { headers?: Record<string, string>; method?: string } = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: { host: "localhost:3000", cookie, authorization: "Bearer secret", ...init.headers },
  });
const forwarded = (res: Response) => (res.headers.get("x-middleware-override-headers") ?? "").split(",");

describe("proxy", () => {
  it("forwards the session cookie to the admin and the API", () => {
    for (const path of ["/", "/acme-org/sites", "/api/app/session", "/api/auth/get-session"]) {
      const res = proxy(request(path));
      expect(forwarded(res), path).toContain("cookie");
      expect(res.headers.get("x-middleware-request-cookie"), path).toBe(cookie);
      expect(res.headers.get("x-middleware-rewrite"), path).toBeNull();
    }
  });

  it("rewrites /s/{address} to the renderer WITHOUT the cookie or authorization header", () => {
    const res = proxy(request("/s/acme/about"));
    expect(res.headers.get("x-middleware-rewrite")).toBe("http://localhost:3000/render/address~acme/about");
    expect(forwarded(res)).not.toContain("cookie");
    expect(forwarded(res)).not.toContain("authorization");
    expect(res.headers.get("x-middleware-request-cookie")).toBeNull();
    expect(res.headers.get("x-middleware-request-authorization")).toBeNull();
    expect(JSON.stringify([...res.headers])).not.toContain("secret-session-token");
    expect(forwarded(res)).toContain("x-request-id");
  });

  it("answers Server Action requests on site pages with 404, and frames per surface", () => {
    expect(proxy(request("/s/acme", { method: "POST", headers: { "next-action": "abc" } })).status).toBe(404);
    expect(proxy(request("/render/address~acme")).status).toBe(404);
    expect(proxy(request("/")).headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(proxy(request("/s/acme")).headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });
});
