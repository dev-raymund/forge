import { describe, expect, it } from "vitest";
import { decideRoute, normalizeHost, type RouteInput } from "./hosts";

describe("normalizeHost", () => {
  it.each([
    ["App.Forgecms.com", "app.forgecms.com"],
    ["acme.forge-host.com:443", "acme.forge-host.com"],
    ["client.com.", "client.com"],
    ["WWW.Client.COM.:8080", "www.client.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["acme.sites.localhost:3100", "acme.sites.localhost"],
  ])("%s → %s", (raw, expected) => expect(normalizeHost(raw)).toBe(expected));

  it.each([[null], [""], ["evil.com/path"], ["a b.com"], ["user@host.com"], ["[::1]:3000"], ["x".repeat(254)]])(
    "rejects %s",
    (raw) => expect(normalizeHost(raw)).toBeNull(),
  );
});

const base: RouteInput = {
  host: "app.forgecms.com",
  pathname: "/",
  search: "",
  nextAction: false,
  appHost: "app.forgecms.com",
  overrideAllowed: false,
};
const route = (over: Partial<RouteInput>) => decideRoute({ ...base, ...over });

describe("decideRoute", () => {
  it.each<[string, Partial<RouteInput>, ReturnType<typeof decideRoute>]>([
    ["app host → admin/API", {}, { kind: "app" }],
    ["app host API", { pathname: "/api/v1/sites" }, { kind: "app" }],
    ["app host Server Action", { nextAction: true }, { kind: "app" }],
    ["site host root → render", { host: "acme.forge-host.com" }, { kind: "site", host: "acme.forge-host.com", rewrite: "/render/acme.forge-host.com" }],
    ["site host path + query", { host: "client.com", pathname: "/blog/hello", search: "?page=2" },
      { kind: "site", host: "client.com", rewrite: "/render/client.com/blog/hello?page=2" }],
    ["site host can't reach admin routes (they become site paths)", { host: "client.com", pathname: "/acme/sites" },
      { kind: "site", host: "client.com", rewrite: "/render/client.com/acme/sites" }],
    ["site host can't reach the API (becomes a site path)", { host: "client.com", pathname: "/api/v1/sites" },
      { kind: "site", host: "client.com", rewrite: "/render/client.com/api/v1/sites" }],
    ["Server Action on a site host → 404", { host: "client.com", nextAction: true }, { kind: "not-found", reason: "action-on-site-host" }],
    ["direct /render on the app host → 404", { pathname: "/render/client.com/x" }, { kind: "not-found", reason: "render-path" }],
    ["direct /render on a site host → 404", { host: "client.com", pathname: "/render" }, { kind: "not-found", reason: "render-path" }],
    ["/renderer is an ordinary path", { host: "client.com", pathname: "/renderer" },
      { kind: "site", host: "client.com", rewrite: "/render/client.com/renderer" }],
    ["missing Host → 404", { host: null }, { kind: "not-found", reason: "bad-host" }],
    ["unknown app host config → 503", { appHost: null }, { kind: "unavailable", reason: "app-host-not-configured" }],
    ["unknown app host config still serves health", { appHost: null, pathname: "/api/health/ready" }, { kind: "app" }],
  ])("%s", (_name, input, expected) => expect(route(input)).toEqual(expected));

  describe("?__host= override", () => {
    it("is ignored in production", () => {
      expect(route({ search: "?__host=acme.sites.localhost" })).toEqual({ kind: "app" });
    });

    it("outside production renders the given host and drops the parameter", () => {
      expect(route({ overrideAllowed: true, pathname: "/about", search: "?__host=Acme.Sites.Localhost&x=1" })).toEqual({
        kind: "site",
        host: "acme.sites.localhost",
        rewrite: "/render/acme.sites.localhost/about?x=1",
      });
    });

    it("still blocks Server Actions and rejects junk hosts", () => {
      expect(route({ overrideAllowed: true, search: "?__host=acme.sites.localhost", nextAction: true })).toEqual({
        kind: "not-found",
        reason: "action-on-site-host",
      });
      expect(route({ overrideAllowed: true, search: "?__host=a/b" })).toEqual({ kind: "not-found", reason: "bad-host" });
    });
  });
});
