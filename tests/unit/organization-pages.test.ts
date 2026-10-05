import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two rules about the organization pages (M3-3) that nothing else would catch
 * until it had gone wrong, checked by reading the source:
 *
 *  1. Every page and layout under `/{orgSlug}` asks for the member's context
 *     itself. A layout is not rendered again when the browser moves between
 *     its pages, so a page that relied on it would be open to anyone who got
 *     there by a link.
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
  const routeFiles = filesUnder(ORG_ROUTES).filter((file) => /\/(page|layout)\.tsx$/.test(file));

  it("finds the routes it is supposed to guard", () => {
    expect(routeFiles.map(relative).sort()).toEqual(
      expect.arrayContaining(["src/app/(admin)/[orgSlug]/layout.tsx", "src/app/(admin)/[orgSlug]/page.tsx", "src/app/(admin)/[orgSlug]/settings/page.tsx"]),
    );
  });

  it.each(routeFiles.map((file) => [relative(file), file] as const))("%s resolves the member's context itself", (_name, file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/\brequireOrgPage\(/);
    // The organization comes from the URL segment, and from nowhere else.
    expect(source).toMatch(/const \{ orgSlug \} = await params|\[\{ orgSlug \}, \w+\] = await Promise\.all\(\[params/);
    expect(source).not.toMatch(/searchParams\.(org|orgSlug|organization)|cookies\(\)|headers\(\)/);
  });

  it("no page under an organization reads the session's organization, because there is none", () => {
    for (const file of filesUnder(path.join(ROOT, "src")).filter(isSource)) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(file)).not.toMatch(/activeOrganization|active_organization|currentOrganizationId|lastOrganization/);
    }
  });
});

describe("nothing about a member's organizations is cached across requests", () => {
  const roots = ["src/modules/tenancy", "src/app/(admin)/[orgSlug]", "src/app/(admin)/onboarding", "src/app/(admin)/account", "src/app/(admin)/route.ts", "src/components/admin"];
  const sources = roots.flatMap((root) => filesUnder(path.join(ROOT, root))).filter(isSource);

  it("covers the tenancy module, the organization routes and the admin shell", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.map(relative)).toEqual(expect.arrayContaining(["src/modules/tenancy/organizations.service.ts", "src/components/admin/app-header.tsx", "src/app/(admin)/route.ts"]));
  });

  it.each(sources.map((file) => [relative(file)] as const))("%s", (name) => {
    const source = readFileSync(path.join(ROOT, name), "utf8");
    expect(source).not.toMatch(/^\s*["']use cache["']/m);
    expect(source).not.toMatch(/\b(unstable_cache|cacheTag|cacheLife|revalidateTag|updateTag)\(/);
  });
});
