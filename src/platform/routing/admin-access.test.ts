import { describe, expect, it } from "vitest";
import {
  decideAdminAccess, isAuthPage, isDocumentNavigation, isLoginReason, isPublicAppPath, loginPath, safeNextPath, type AdminAccessInput,
} from "./admin-access";

describe("safeNextPath", () => {
  it.each([
    ["/acme-org/sites", "/acme-org/sites"],
    ["/acme-org/sites?tab=members&page=2", "/acme-org/sites?tab=members&page=2"],
    ["/acme-org/sites/main/pages/123#seo", "/acme-org/sites/main/pages/123#seo"],
    ["/account", "/account"],
    ["/onboarding", "/onboarding"],
    ["/verify-email", "/verify-email"],
    ["/a/../b", "/b"], // normalised, still on this app
    ["/%2F%2Fevil.example", "/%2F%2Fevil.example"], // an encoded slash is just a path segment
  ])("keeps %s", (raw, expected) => expect(safeNextPath(raw)).toBe(expected));

  it.each([
    ["absolute URL", "https://evil.example/"],
    ["absolute URL, http", "http://evil.example"],
    ["protocol-relative", "//evil.example"],
    ["protocol-relative with path", "//evil.example/login"],
    ["backslash (browsers read it as a slash)", "/\\evil.example"],
    ["backslashes", "\\\\evil.example"],
    ["dot segment that normalises to //host", "/.//evil.example"],
    ["dot-dot that normalises to //host", "/x/..//evil.example"],
    ["tab inside the slashes (browsers strip it)", "/\t/evil.example"],
    ["newline", "/\n/evil.example"],
    ["NUL", "/\u0000"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["no leading slash", "acme-org/sites"],
    ["bare host", "evil.example"],
    ["userinfo trick", "/@evil.example/../..//evil.example"],
    ["empty", ""],
    ["just whitespace", " "],
    ["leading space", " /acme"],
    ["too long", `/${"a".repeat(2100)}`],
    // Not admin pages: the sign-in screens (they would bounce back), APIs, tenant sites, internals.
    ["login", "/login"],
    ["login with its own next", "/login?next=/x"],
    ["signup", "/signup"],
    ["forgot password", "/forgot-password"],
    ["reset password", "/reset-password?token=abc"],
    ["an API", "/api/auth/sign-out"],
    ["the API root", "/api"],
    ["a tenant site", "/s/acme"],
    ["a tenant site page", "/s/acme/about"],
    ["the renderer", "/render/address~acme"],
    ["media", "/media/o/1/file.png"],
    ["next internals", "/_next/static/x.js"],
    ["previews", "/_forge/preview/token"],
  ])("rejects %s", (_name, raw) => expect(safeNextPath(raw)).toBe("/"));

  it.each([[undefined], [null], [42], [["/a", "/b"]], [{ toString: () => "/a" }], [new File([], "x")]])("rejects non-strings (%s)", (raw) =>
    expect(safeNextPath(raw)).toBe("/"),
  );

  it("uses the given fallback", () => {
    expect(safeNextPath("https://evil.example", "/account")).toBe("/account");
    expect(safeNextPath("/s", "/account")).toBe("/account");
    expect(safeNextPath("/sites", "/account")).toBe("/sites"); // "/s" is a prefix only at a segment boundary
  });

  it("never returns anything a browser would resolve to another origin", () => {
    const hostile = [
      "https://evil.example", "//evil.example", "/\\evil.example", "/.//evil.example", "/..//evil.example", "/x/..//evil.example",
      "/%09/evil.example", "///evil.example", "/./\\evil.example", "http:evil.example", "/\t//evil.example", "https:/evil.example",
    ];
    for (const raw of hostile) {
      const out = safeNextPath(raw);
      expect(new URL(out, "https://cms.forgelinetechnologies.com").origin, raw).toBe("https://cms.forgelinetechnologies.com");
      expect(out.startsWith("//"), raw).toBe(false);
    }
  });
});

describe("loginPath", () => {
  it("adds the destination and the reason only when they say something", () => {
    expect(loginPath()).toBe("/login");
    expect(loginPath({ next: "/" })).toBe("/login");
    expect(loginPath({ next: "/acme-org/sites?tab=members" })).toBe("/login?next=%2Facme-org%2Fsites%3Ftab%3Dmembers");
    expect(loginPath({ reason: "session" })).toBe("/login?reason=session");
    expect(loginPath({ next: "/account", reason: "session" })).toBe("/login?next=%2Faccount&reason=session");
  });

  it("drops an unsafe destination", () => {
    expect(loginPath({ next: "https://evil.example" })).toBe("/login");
    expect(loginPath({ next: "/login?next=/login" })).toBe("/login");
  });

  it("knows its reasons", () => {
    expect(isLoginReason("session")).toBe(true);
    expect(isLoginReason("password-reset")).toBe(true);
    expect(isLoginReason("signed-out")).toBe(true);
    expect(isLoginReason("<script>")).toBe(false);
    expect(isLoginReason(undefined)).toBe(false);
  });
});

describe("public and protected paths", () => {
  it.each(["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password"])("%s is an auth page", (p) => {
    expect(isAuthPage(p)).toBe(true);
    expect(isPublicAppPath(p)).toBe(true);
  });

  it.each(["/api/v1/sites", "/api/auth/sign-in/email", "/api/app/session", "/api/health", "/api/internal/cron", "/media/o/1/a.png",
    "/invite/abc", "/_forge/preview/t", "/_next/data/x", "/dev/cache", "/.well-known/security.txt", "/favicon.ico", "/robots.txt",
  ])("%s answers without the login redirect", (p) => expect(isPublicAppPath(p)).toBe(true));

  it.each(["/", "/onboarding", "/account", "/platform", "/acme-org", "/acme-org/sites/main/pages", "/loginx", "/apix", "/medias", "/devtools",
    "/login-as", "/no-such-page",
  ])("%s needs a session", (p) => expect(isPublicAppPath(p)).toBe(false));
});

describe("decideAdminAccess", () => {
  const base: AdminAccessInput = { method: "GET", pathname: "/", search: "", hasSessionCookie: false, nextAction: false };
  const decide = (over: Partial<AdminAccessInput>) => decideAdminAccess({ ...base, ...over });

  it("sends an anonymous visitor on a protected page to the login page, and back afterwards", () => {
    expect(decide({})).toEqual({ kind: "login", location: "/login" });
    expect(decide({ pathname: "/acme-org/sites", search: "?tab=members" })).toEqual({
      kind: "login", location: "/login?next=%2Facme-org%2Fsites%3Ftab%3Dmembers",
    });
    expect(decide({ pathname: "/account", method: "HEAD" })).toEqual({ kind: "login", location: "/login?next=%2Faccount" });
  });

  it("lets a request with a session cookie through (the page decides whether it is valid)", () => {
    expect(decide({ hasSessionCookie: true })).toEqual({ kind: "pass" });
    expect(decide({ hasSessionCookie: true, pathname: "/acme-org/sites" })).toEqual({ kind: "pass" });
    // Never away from the login page on the strength of a cookie: a stale one would loop.
    expect(decide({ hasSessionCookie: true, pathname: "/login" })).toEqual({ kind: "pass" });
  });

  it("never redirects public paths", () => {
    for (const pathname of ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password", "/api/v1/sites", "/api/app/session",
      "/api/auth/get-session", "/media/x", "/dev/cache", "/invite/t"]) {
      expect(decide({ pathname }), pathname).toEqual({ kind: "pass" });
    }
  });

  it("never redirects writes or Server Actions: they authenticate themselves and answer with a result", () => {
    expect(decide({ method: "POST" })).toEqual({ kind: "pass" });
    expect(decide({ method: "DELETE", pathname: "/acme-org/sites" })).toEqual({ kind: "pass" });
    expect(decide({ nextAction: true, pathname: "/acme-org/sites" })).toEqual({ kind: "pass" });
  });

  it("a path that could not be a destination still gets a plain login redirect", () => {
    expect(decide({ pathname: "/x", search: `?q=${"a".repeat(3000)}` })).toEqual({ kind: "login", location: "/login" });
  });
});

describe("isDocumentNavigation", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it("is a full page load, not a transition, prefetch, data request or write", () => {
    expect(isDocumentNavigation("GET", h({ "sec-fetch-dest": "document" }))).toBe(true);
    expect(isDocumentNavigation("GET", h({ accept: "text/html,application/xhtml+xml" }))).toBe(true); // no fetch metadata
    expect(isDocumentNavigation("GET", h({ "sec-fetch-dest": "empty", accept: "text/html" }))).toBe(false);
    expect(isDocumentNavigation("GET", h({ "sec-fetch-dest": "document", rsc: "1" }))).toBe(false);
    expect(isDocumentNavigation("GET", h({ "sec-fetch-dest": "document", "next-router-prefetch": "1" }))).toBe(false);
    expect(isDocumentNavigation("POST", h({ "sec-fetch-dest": "document" }))).toBe(false);
    expect(isDocumentNavigation("GET", h({ accept: "application/json" }))).toBe(false);
    expect(isDocumentNavigation("GET", h({}))).toBe(false);
  });
});
