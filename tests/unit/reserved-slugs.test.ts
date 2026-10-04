import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkOrgSlug, RESERVED_ORG_SLUGS } from "@/modules/tenancy/slugs";
import { AUTH_PAGES } from "@/platform/routing/admin-access";
import { RENDER_PREFIX, SITE_PATH_PREFIX } from "@/platform/routing/hosts";

/**
 * An organization's slug is the first segment of its admin URLs. If a
 * top-level route of the app could also be somebody's slug, one of the two
 * would be unreachable. This test reads the routes that exist and fails when
 * one of them is not reserved.
 */

const APP = path.resolve(import.meta.dirname, "../../src/app");

/** First URL segments served by a directory of the app router: `(groups)` are transparent, `[params]` are not literal. */
function topLevelSegments(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    if (entry.name.startsWith("(")) return topLevelSegments(path.join(dir, entry.name));
    if (entry.name.startsWith("[") || entry.name.startsWith("_") || entry.name.startsWith("@")) return [];
    return [entry.name];
  });
}

describe("reserved organization slugs", () => {
  const routes = topLevelSegments(APP);

  it("finds the routes it is supposed to guard", () => {
    for (const expected of ["login", "signup", "account", "api", "dev", "render"]) expect(routes).toContain(expected);
  });

  it("every top-level route of the app is unavailable as an organization slug", () => {
    for (const segment of routes) expect(checkOrgSlug(segment).ok, `/${segment} could be an organization's slug`).toBe(false);
  });

  it("so are the prefixes the proxy routes, and the account screens", () => {
    const prefixes = [SITE_PATH_PREFIX, RENDER_PREFIX, "/media", "/api", "/_forge", "/_next", ...AUTH_PAGES].map((p) => p.slice(1));
    for (const segment of prefixes) expect(checkOrgSlug(segment).ok, `/${segment}`).toBe(false);
  });

  it("contains the plan's list (§19)", () => {
    for (const slug of ["login", "signup", "onboarding", "account", "invite", "platform", "api", "verify-email", "forgot-password",
      "reset-password", "settings", "new", "_next", "s", "media"]) {
      expect(RESERVED_ORG_SLUGS.has(slug), slug).toBe(true);
    }
  });
});
