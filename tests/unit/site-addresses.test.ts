import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkSiteAddress, RESERVED_SITE_ADDRESSES, RESERVED_SITE_SLUGS } from "@/modules/sites/shared";
import { AUTH_PAGES } from "@/platform/routing/admin-access";
import { decideRoute, type RouteInput } from "@/platform/routing/hosts";

/**
 * Why a site address needs no list of the app's own paths (M4-1, ADR 0011).
 *
 * In V1 an address only ever appears after `/s/`. The router decides `/s/…`
 * before anything else, so a site called `login` lives at `/s/login`, and
 * `/login` is still the login page. This test walks every top-level route of
 * the app (and the prefixes the proxy routes) and checks both halves: the
 * site's address leads to that site, and the app's path still leads to the
 * app. The reserved list is for the platform's own labels under the sites
 * domain (host mode, post-V1), not for paths.
 *
 * It also checks the other side of the sites area: a page added under
 * `/{orgSlug}/sites/` with a literal name must be a reserved site slug, or
 * a site could never be reached at its admin URL.
 */

const APP = path.resolve(import.meta.dirname, "../../src/app");

function topLevelSegments(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    if (entry.name.startsWith("(")) return topLevelSegments(path.join(dir, entry.name));
    if (entry.name.startsWith("[") || entry.name.startsWith("@")) return [];
    return [entry.name];
  });
}

const V1: Omit<RouteInput, "pathname"> = { host: "cms.forgelinetechnologies.com", search: "", nextAction: false, appHost: "cms.forgelinetechnologies.com", hostRouting: false, sitesRootDomain: null, overrideAllowed: false };
const route = (pathname: string) => decideRoute({ ...V1, pathname });

describe("a site's address cannot take a path from the app", () => {
  const routes = topLevelSegments(APP);
  const names = [...new Set([...routes, "api", "login", "signup", "account", "onboarding", "s", "media", "_forge", "dev", "render", "invite", ...AUTH_PAGES.map((p) => p.slice(1))])];

  it("finds the app's routes", () => {
    for (const expected of ["login", "signup", "account", "onboarding", "api", "dev", "render"]) expect(routes).toContain(expected);
  });

  it.each(names.map((name) => [name] as const))("/%s", (name) => {
    // The app's own path is the app's, whatever sites exist. (`/s` and `/render` are the sites' own prefixes.)
    if (name !== "render" && name !== "s") expect(route(`/${name}`).kind, `/${name}`).toBe("app");
    // The same word as an address: either it is not an address at all, or it is a site, only under /s/.
    const checked = checkSiteAddress(name);
    const atSite = route(`/s/${name}`);
    if (checked.ok) {
      expect(atSite).toEqual({ kind: "site", locator: { kind: "address", address: name }, rewrite: `/render/address~${name}` });
      expect(route(`/s/${name}/about`)).toMatchObject({ kind: "site", rewrite: `/render/address~${name}/about` });
    } else {
      expect(RESERVED_SITE_ADDRESSES.has(name) || atSite.kind === "not-found", name).toBe(true);
    }
  });

  it("`/s` itself, and an address with nothing in it, are no site", () => {
    expect(route("/s").kind).toBe("not-found");
    expect(route("/s/").kind).toBe("not-found");
    expect(route("/s/_forge")).toEqual({ kind: "not-found", reason: "bad-address" });
  });

  it("the reserved addresses are the platform's labels, not paths", () => {
    expect([...RESERVED_SITE_ADDRESSES].sort()).toEqual(["admin", "api", "app", "media", "www"]);
  });
});

describe("the sites area's own pages are reserved site slugs", () => {
  const SITES = path.join(APP, "(admin)/[orgSlug]/sites");
  const literal = readdirSync(SITES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("[") && !entry.name.startsWith("("))
    .map((entry) => entry.name);

  it("finds them", () => {
    expect(literal).toContain("new");
  });

  it("every one of them is reserved", () => {
    for (const segment of literal) expect(RESERVED_SITE_SLUGS.has(segment), `/{orgSlug}/sites/${segment} could be a site's slug`).toBe(true);
  });
});
