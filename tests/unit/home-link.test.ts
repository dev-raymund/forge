import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { linkPrefetch, SIGNED_IN_HOME } from "@/platform/routing/admin-access";

/**
 * `/` is a route handler, not a page (plan §19), and a `<Link>` to it is never
 * prefetched (ADR 0004, M3-5 addendum): the request would run the handler for
 * a user who clicked nothing, and against a dead session it removes the cookie
 * that their next action needs in order to be told the session ended.
 *
 * The rule itself is `linkPrefetch`. The second half reads the source, because
 * `prefetch` leaves no trace in the markup a component test could look at.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

function componentsUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return componentsUnder(full);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [full] : [];
  });
}

/** Every opening `<Link …>` tag of a file. None of ours has a `>` inside an attribute. */
const linkTags = (source: string) => source.match(/<Link\b[^>]*>/g) ?? [];
const pointsHome = (tag: string) => /\bhref=(?:"\/"|\{"\/"\}|\{SIGNED_IN_HOME\})/.test(tag);

describe("links to `/` are not prefetched", () => {
  it("the rule: never for `/`, the default for everything else", () => {
    expect(SIGNED_IN_HOME).toBe("/");
    expect(linkPrefetch("/")).toBe(false);
    for (const href of ["/acme", "/account", "/acme/activity?before=1", "/login", ""]) expect(linkPrefetch(href)).toBeNull();
  });

  const files = componentsUnder(path.join(ROOT, "src"));
  const tags = files.flatMap((file) => linkTags(readFileSync(file, "utf8")).map((tag) => ({ file: path.relative(ROOT, file), tag })));

  it("looks at the whole application", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(tags.length).toBeGreaterThan(10);
    expect(tags.filter(({ tag }) => pointsHome(tag)).map(({ file }) => file).sort()).toEqual(["src/app/(admin)/not-found.tsx", "src/modules/auth/ui/auth-card.tsx"]);
  });

  it("a link written to `/` says so itself", () => {
    const offenders = tags.filter(({ tag }) => pointsHome(tag) && !/\bprefetch=\{false\}/.test(tag));
    expect(offenders).toEqual([]);
  });

  it("no link points at `/{orgSlug}`, a route handler since M4-1: links go to the organization's sites", () => {
    expect(tags.filter(({ tag }) => /\bhref=\{orgPath\(/.test(tag))).toEqual([]);
  });

  it("the two links whose address is decided at run time ask the rule", () => {
    for (const file of ["src/modules/auth/ui/auth-card.tsx", "src/components/admin/app-header.tsx"]) {
      const computed = linkTags(readFileSync(path.join(ROOT, file), "utf8")).filter((tag) => /\bhref=\{(?:href|home)\}/.test(tag));
      expect(computed, file).toHaveLength(1);
      expect(computed[0], file).toMatch(/\bprefetch=\{linkPrefetch\((?:href|home)\)\}/);
    }
  });
});
