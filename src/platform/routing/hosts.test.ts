import { describe, expect, it } from "vitest";
import {
  decideRoute, decodeSiteLocator, encodeSiteLocator, isSiteAddress, locatorForHost, normalizeHost, siteBasePath,
  type RouteInput,
} from "./hosts";

describe("normalizeHost", () => {
  it.each([
    ["CMS.ForgelineTechnologies.com", "cms.forgelinetechnologies.com"],
    ["acme.sites.example.com:443", "acme.sites.example.com"],
    ["client.com.", "client.com"],
    ["WWW.Client.COM.:8080", "www.client.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["localhost:3100", "localhost"],
  ])("%s → %s", (raw, expected) => expect(normalizeHost(raw)).toBe(expected));

  it.each([[null], [""], ["evil.com/path"], ["a b.com"], ["user@host.com"], ["[::1]:3000"], ["a~b.com"], ["x".repeat(254)]])(
    "rejects %s",
    (raw) => expect(normalizeHost(raw)).toBeNull(),
  );
});

describe("site addresses and locators", () => {
  it.each([["acme", true], ["acme-co", true], ["a1", true], ["x".repeat(63), true],
    ["Acme", false], ["-acme", false], ["acme-", false], ["ac--me", false], ["acme.co", false], ["", false], ["x".repeat(64), false],
  ])("isSiteAddress(%s) = %s", (value, ok) => expect(isSiteAddress(value)).toBe(ok));

  it("round-trips locators through the renderer segment", () => {
    for (const locator of [{ kind: "address", address: "acme" }, { kind: "host", hostname: "client.com" }] as const) {
      expect(decodeSiteLocator(encodeSiteLocator(locator))).toEqual(locator);
    }
    expect(decodeSiteLocator("address~Acme")).toBeNull();
    expect(decodeSiteLocator("host~a b")).toBeNull();
    expect(decodeSiteLocator("acme")).toBeNull();
    expect(decodeSiteLocator("address~a~b")).toBeNull();
    expect(decodeSiteLocator("__placeholder")).toBeNull();
  });

  it("gives path-mode sites a base path and host-mode sites none", () => {
    expect(siteBasePath({ kind: "address", address: "acme" })).toBe("/s/acme");
    expect(siteBasePath({ kind: "host", hostname: "client.com" })).toBe("");
  });

  it("maps platform subdomains to addresses in host mode", () => {
    expect(locatorForHost("acme.sites.example.com", "sites.example.com")).toEqual({ kind: "address", address: "acme" });
    expect(locatorForHost("a.b.sites.example.com", "sites.example.com")).toEqual({ kind: "host", hostname: "a.b.sites.example.com" });
    expect(locatorForHost("client.com", "sites.example.com")).toEqual({ kind: "host", hostname: "client.com" });
    expect(locatorForHost("client.com", null)).toEqual({ kind: "host", hostname: "client.com" });
  });
});

const APP = "cms.forgelinetechnologies.com";
const pathMode: RouteInput = {
  host: APP,
  pathname: "/",
  search: "",
  nextAction: false,
  appHost: APP,
  hostRouting: false,
  sitesRootDomain: null,
  overrideAllowed: false,
};
const route = (over: Partial<RouteInput>) => decideRoute({ ...pathMode, ...over });
const acme = { kind: "address", address: "acme" } as const;

describe("decideRoute — V1 path mode (one host)", () => {
  it.each<[string, Partial<RouteInput>, ReturnType<typeof decideRoute>]>([
    ["admin root", {}, { kind: "app" }],
    ["admin org route", { pathname: "/acme-org/sites/main/pages" }, { kind: "app" }],
    ["REST API", { pathname: "/api/v1/sites" }, { kind: "app" }],
    ["media", { pathname: "/media/o/1/s/2/m/3/v1/w800.webp" }, { kind: "app" }],
    ["admin Server Action", { pathname: "/acme-org/sites", nextAction: true }, { kind: "app" }],
    ["site home", { pathname: "/s/acme" }, { kind: "site", locator: acme, rewrite: "/render/address~acme" }],
    ["site page + query", { pathname: "/s/acme/blog/hello-world", search: "?page=2" },
      { kind: "site", locator: acme, rewrite: "/render/address~acme/blog/hello-world?page=2" }],
    ["admin-looking path under a site is just a site path", { pathname: "/s/acme/api/v1/sites" },
      { kind: "site", locator: acme, rewrite: "/render/address~acme/api/v1/sites" }],
    ["Server Action on a site page → 404", { pathname: "/s/acme/about", nextAction: true }, { kind: "not-found", reason: "action-on-site" }],
    ["/s alone → 404", { pathname: "/s" }, { kind: "not-found", reason: "bad-address" }],
    ["invalid address → 404", { pathname: "/s/Acme" }, { kind: "not-found", reason: "bad-address" }],
    ["/sx is an ordinary admin path", { pathname: "/sx" }, { kind: "app" }],
    ["direct /render → 404", { pathname: "/render/address~acme" }, { kind: "not-found", reason: "render-path" }],
    ["any host serves the app (previews, *.vercel.app)", { host: "forge-git-x.vercel.app" }, { kind: "app" }],
    ["sites work on any host too", { host: "localhost", pathname: "/s/acme" }, { kind: "site", locator: acme, rewrite: "/render/address~acme" }],
    ["no app host needed in path mode", { appHost: null, pathname: "/s/acme" }, { kind: "site", locator: acme, rewrite: "/render/address~acme" }],
    ["?__host= is ignored in path mode", { overrideAllowed: true, search: "?__host=client.com" }, { kind: "app" }],
  ])("%s", (_name, input, expected) => expect(route(input)).toEqual(expected));
});

describe("decideRoute — post-V1 host mode", () => {
  const hostMode = (over: Partial<RouteInput>) =>
    route({ hostRouting: true, sitesRootDomain: "sites.example.com", ...over });

  it.each<[string, Partial<RouteInput>, ReturnType<typeof decideRoute>]>([
    ["app host → admin/API", {}, { kind: "app" }],
    ["platform subdomain → address", { host: "acme.sites.example.com", pathname: "/about" },
      { kind: "site", locator: acme, rewrite: "/render/address~acme/about" }],
    ["custom domain → host", { host: "client.com", pathname: "/blog", search: "?p=1" },
      { kind: "site", locator: { kind: "host", hostname: "client.com" }, rewrite: "/render/host~client.com/blog?p=1" }],
    ["custom domain can't reach the admin (becomes a site path)", { host: "client.com", pathname: "/acme-org/sites" },
      { kind: "site", locator: { kind: "host", hostname: "client.com" }, rewrite: "/render/host~client.com/acme-org/sites" }],
    ["Server Action on a site host → 404", { host: "client.com", nextAction: true }, { kind: "not-found", reason: "action-on-site" }],
    ["path-mode sites still work on the app host", { pathname: "/s/acme" }, { kind: "site", locator: acme, rewrite: "/render/address~acme" }],
    ["direct /render on a site host → 404", { host: "client.com", pathname: "/render" }, { kind: "not-found", reason: "render-path" }],
    ["missing Host → 404", { host: null }, { kind: "not-found", reason: "bad-host" }],
    ["app host not configured → 503", { appHost: null }, { kind: "unavailable", reason: "app-host-not-configured" }],
    ["…but health still answers", { appHost: null, pathname: "/api/health/ready" }, { kind: "app" }],
  ])("%s", (_name, input, expected) => expect(hostMode(input)).toEqual(expected));

  it("?__host= renders a tenant outside production and drops the parameter", () => {
    expect(hostMode({ overrideAllowed: true, pathname: "/about", search: "?__host=Acme.Sites.Example.com&x=1" })).toEqual({
      kind: "site", locator: acme, rewrite: "/render/address~acme/about?x=1",
    });
    expect(hostMode({ search: "?__host=client.com" })).toEqual({ kind: "app" }); // production
    expect(hostMode({ overrideAllowed: true, search: "?__host=a/b" })).toEqual({ kind: "not-found", reason: "bad-host" });
  });
});
