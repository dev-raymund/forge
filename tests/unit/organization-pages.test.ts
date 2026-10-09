import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two rules about the organization pages (M3-3) that nothing else would catch
 * until it had gone wrong, checked by reading the source:
 *
 *  1. Every page and layout under `/{orgSlug}` asks for the member's context
 *     itself (`requireOrgPage`, or `requireSitePage` under a site, M4-1). A
 *     layout is not rendered again when the browser moves between its pages,
 *     so a page that relied on it would be open to anyone who got there by a
 *     link. And `/{orgSlug}` itself, a redirect since M4-1, looks nothing up.
 *  2. Nothing that depends on who is signed in is cached across requests. An
 *     organization list or a membership in a shared cache entry would be shown
 *     to the next user.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const ORG_ROUTES = path.join(ROOT, "src/app/(admin)/[orgSlug]");

function filesUnder(target: string): string[] {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(target, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}
const relative = (file: string) => path.relative(ROOT, file);
const isSource = (file: string) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file);

describe("pages of an organization", () => {
  // The organization's own pages, and onboarding's steps 2 and 3 (M4-2), which name an organization and a site in their URLs too.
  const ONBOARDING_ORG = path.join(ROOT, "src/app/(admin)/onboarding/[orgSlug]");
  const routeFiles = [...filesUnder(ORG_ROUTES), ...filesUnder(ONBOARDING_ORG)].filter((file) => /\/(page|layout)\.tsx$/.test(file));

  it("finds the routes it is supposed to guard", () => {
    expect(routeFiles.map(relative).sort()).toEqual(
      expect.arrayContaining([
        "src/app/(admin)/[orgSlug]/layout.tsx",
        "src/app/(admin)/[orgSlug]/settings/page.tsx",
        "src/app/(admin)/[orgSlug]/sites/page.tsx",
        "src/app/(admin)/[orgSlug]/sites/new/page.tsx",
        "src/app/(admin)/[orgSlug]/sites/[siteSlug]/layout.tsx",
        "src/app/(admin)/[orgSlug]/sites/[siteSlug]/page.tsx",
        "src/app/(admin)/[orgSlug]/sites/[siteSlug]/settings/page.tsx",
        "src/app/(admin)/onboarding/[orgSlug]/page.tsx",
        "src/app/(admin)/onboarding/[orgSlug]/[siteSlug]/page.tsx",
      ]),
    );
  });

  it.each(routeFiles.map((file) => [relative(file), file] as const))("%s resolves the member's context itself", (_name, file) => {
    const source = readFileSync(file, "utf8");
    const underSite = file.includes(`${path.sep}[siteSlug]${path.sep}`);
    expect(source).toMatch(underSite ? /\brequireSitePage\(/ : /\brequireOrgPage\(/);
    // The organization (and the site) come from the URL segments, and from nowhere else.
    expect(source).toMatch(/const \{ orgSlug(, siteSlug)? \} = await params|\[\{ orgSlug \}, \w+\] = await Promise\.all\(\[params/);
    expect(source).not.toMatch(/searchParams\.(org|orgSlug|organization)|cookies\(\)|headers\(\)/);
  });

  it("`/{orgSlug}` is a redirect that reads no session and no database: the same answer for every organization and every visitor", () => {
    const source = readFileSync(path.join(ORG_ROUTES, "route.ts"), "utf8");
    expect(existsSync(path.join(ORG_ROUTES, "page.tsx"))).toBe(false);
    expect(source).toMatch(/status: 307, headers: \{ location: orgSitesPath\(orgSlug\) \}/);
    expect(source).not.toMatch(/requireAuth|getCurrent|requireOrg|resolveOrg|cookies\(\)|headers\(\)|withTenant|withUser|inTenant/);
  });

  it("no page under an organization reads the session's organization, because there is none", () => {
    for (const file of filesUnder(path.join(ROOT, "src")).filter(isSource)) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(file)).not.toMatch(/activeOrganization|active_organization|currentOrganizationId|lastOrganization/);
    }
  });
});

describe("nothing about a member's organizations is cached across requests", () => {
  const roots = ["src/modules/tenancy", "src/modules/sites", "src/app/(admin)/[orgSlug]", "src/app/(admin)/onboarding", "src/app/(admin)/account", "src/app/(admin)/route.ts", "src/components/admin"];
  const sources = roots.flatMap((root) => filesUnder(path.join(ROOT, root))).filter(isSource);

  it("covers the tenancy and sites modules, the organization routes and the admin shell", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map(relative)).toEqual(
      expect.arrayContaining(["src/modules/tenancy/organizations.service.ts", "src/modules/sites/sites.service.ts", "src/components/admin/app-header.tsx", "src/app/(admin)/route.ts"]),
    );
  });

  it.each(sources.map((file) => [relative(file)] as const))("%s", (name) => {
    const source = readFileSync(path.join(ROOT, name), "utf8");
    expect(source).not.toMatch(/^\s*["']use cache["']/m);
    expect(source).not.toMatch(/\b(unstable_cache|cacheTag|cacheLife|revalidateTag|updateTag)\(/);
  });
});
