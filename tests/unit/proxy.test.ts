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

  describe("admin login redirect (a convenience; pages and actions check the session themselves)", () => {
    const anonymous = (path: string, init: { headers?: Record<string, string>; method?: string } = {}) =>
      new NextRequest(`http://localhost:3000${path}`, { method: init.method ?? "GET", headers: { host: "localhost:3000", ...init.headers } });

    it("redirects an anonymous visitor on a protected page to the login page, remembering the page", () => {
      const home = proxy(anonymous("/"));
      expect(home.status).toBe(307);
      expect(home.headers.get("location")).toBe("http://localhost:3000/login");
      const deep = proxy(anonymous("/acme-org/sites?tab=members"));
      expect(deep.status).toBe(307);
      expect(deep.headers.get("location")).toBe("http://localhost:3000/login?next=%2Facme-org%2Fsites%3Ftab%3Dmembers");
      expect(deep.headers.get("x-frame-options")).toBe("DENY");
      expect(deep.headers.get("x-request-id")).toBeTruthy();
    });

    it("leaves the account screens, route handlers, media and dev pages alone", () => {
      for (const path of ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password?token=t", "/api/app/session",
        "/api/auth/sign-in/email", "/api/v1/sites", "/api/health", "/api/internal/cron", "/media/o/1/a.png", "/dev/cache"]) {
        const res = proxy(anonymous(path));
        expect(res.status, path).toBe(200);
        expect(res.headers.get("location"), path).toBeNull();
      }
    });

    it("keeps public sites public: no redirect, with or without a session cookie", () => {
      for (const req of [anonymous("/s/acme"), anonymous("/s/acme/about"), request("/s/acme/about")]) {
        const res = proxy(req);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("x-middleware-rewrite")).toContain("/render/address~acme");
      }
    });

    it("does not redirect writes or Server Actions", () => {
      expect(proxy(anonymous("/acme-org/sites", { method: "POST" })).status).toBe(200);
      expect(proxy(anonymous("/login", { method: "POST", headers: { "next-action": "abc" } })).status).toBe(200);
      expect(proxy(anonymous("/", { headers: { "next-action": "abc" } })).status).toBe(200);
    });

    it("lets a request with a session cookie through, whatever the cookie is worth", () => {
      expect(proxy(request("/")).status).toBe(200);
      expect(proxy(request("/acme-org/sites")).headers.get("location")).toBeNull();
      // On https the cookie carries the __Secure- prefix.
      const secure = anonymous("/", { headers: { cookie: "__Secure-better-auth.session_token=abc" } });
      expect(proxy(secure).status).toBe(200);
      // Some other cookie is not a session.
      expect(proxy(anonymous("/", { headers: { cookie: "theme=dark; better-auth.session_data=x" } })).status).toBe(307);
    });
  });

  describe("session cookie renewal", () => {
    const page = { "sec-fetch-dest": "document", accept: "text/html" };

    it("renews the browser cookie on an admin page load, value untouched", () => {
      const res = proxy(request("/acme-org/sites", { headers: page }));
      expect(res.headers.get("set-cookie")).toBe("better-auth.session_token=secret-session-token; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax");
    });

    it("keeps Secure for the __Secure- cookie", () => {
      const res = proxy(request("/", { headers: { ...page, cookie: "__Secure-better-auth.session_token=abc.def" } }));
      expect(res.headers.get("set-cookie")).toBe("__Secure-better-auth.session_token=abc.def; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax");
    });

    it("never on site pages, data requests, prefetches, writes, or without a session cookie", () => {
      expect(proxy(request("/s/acme/about", { headers: page })).headers.get("set-cookie")).toBeNull();
      expect(proxy(request("/api/app/session", { headers: { "sec-fetch-dest": "empty" } })).headers.get("set-cookie")).toBeNull();
      expect(proxy(request("/", { headers: { ...page, rsc: "1" } })).headers.get("set-cookie")).toBeNull();
      expect(proxy(request("/", { headers: { ...page, "next-router-prefetch": "1" } })).headers.get("set-cookie")).toBeNull();
      expect(proxy(request("/", { method: "POST", headers: page })).headers.get("set-cookie")).toBeNull();
      const anonymous = new NextRequest("http://localhost:3000/login", { headers: { host: "localhost:3000", ...page } });
      expect(proxy(anonymous).headers.get("set-cookie")).toBeNull();
    });
  });

  it("answers Server Action requests on site pages with 404, and frames per surface", () => {
    expect(proxy(request("/s/acme", { method: "POST", headers: { "next-action": "abc" } })).status).toBe(404);
    expect(proxy(request("/render/address~acme")).status).toBe(404);
    expect(proxy(request("/")).headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(proxy(request("/s/acme")).headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });
});
