import { describe, expect, it } from "vitest";
import {
  HOME_PATH, isEntryPath, pagePath, ParentChainError, parentChain, pathFromChain, pathUnder, postPath, RESERVED_PATHS, reservedPathReason, wouldCreateCycle, type PageNode,
} from "./paths";

/** The `entries_path_format` CHECK as migration 0005 leaves it: `/`, or one or more `/segment`s. */
const DATABASE_PATH = (path: string) => path === "/" || /^(\/[a-z0-9]+(-[a-z0-9]+)*)+$/.test(path);

const pages = (...nodes: PageNode[]) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return (id: string) => byId.get(id);
};

describe("paths", () => {
  it("isEntryPath accepts what the database accepts, and nothing else", () => {
    const valid = ["/", "/about", "/about-us", "/about/team", "/blog/hello-world", "/a/b/c/d", "/2026"];
    const invalid = ["", "//", "/ ", " /", "home", "about", "/About", "/a/", "/a//b", "/a b", "/../x", "/a/../b", "/x?y", "/x#y", "/_forge", "/robots.txt", "/a--b", "/-a", "/ü"];
    for (const path of valid) expect([isEntryPath(path), DATABASE_PATH(path)], path).toEqual([true, true]);
    for (const path of invalid) expect([isEntryPath(path), DATABASE_PATH(path)], path).toEqual([false, false]);
  });

  it("pages: the Home page is `/`; a top-level page is `/{slug}`; a child is under its parent; a page under Home is at the top level", () => {
    expect(pagePath({ slug: "home", home: true }, null)).toBe(HOME_PATH);
    expect(pagePath({ slug: "about" }, null)).toBe("/about");
    expect(pagePath({ slug: "team" }, "/about")).toBe("/about/team");
    expect(pagePath({ slug: "people" }, "/about/team")).toBe("/about/team/people");
    expect(pagePath({ slug: "contact" }, "/")).toBe("/contact");
    // Being Home wins over a parent: there is one root.
    expect(pagePath({ slug: "home", home: true }, "/about")).toBe("/");
  });

  it("posts: under the blog's path, whatever it is", () => {
    expect(postPath("hello-world", "blog")).toBe("/blog/hello-world");
    expect(postPath("hello-world", "news")).toBe("/news/hello-world");
    expect(pathUnder("", "x")).toBe("/x");
    expect(pathUnder("/", "x")).toBe("/x");
    expect(pathUnder("/a/b", "x")).toBe("/a/b/x");
  });
});

describe("parent chains", () => {
  const home: PageNode = { id: "home", slug: "home", parentId: null, home: true };
  const about: PageNode = { id: "about", slug: "about", parentId: null };
  const team: PageNode = { id: "team", slug: "team", parentId: "about" };
  const people: PageNode = { id: "people", slug: "people", parentId: "team" };
  const contact: PageNode = { id: "contact", slug: "contact", parentId: "home" };
  const find = pages(home, about, team, people, contact);

  it("from the top level down to the page, and the path built from every slug in it", () => {
    expect(parentChain("people", find).map((node) => node.id)).toEqual(["about", "team", "people"]);
    expect(pathFromChain(parentChain("people", find))).toBe("/about/team/people");
    expect(pathFromChain(parentChain("about", find))).toBe("/about");
    expect(pathFromChain(parentChain("home", find))).toBe("/");
    expect(pathFromChain(parentChain("contact", find))).toBe("/contact");
    expect(() => pathFromChain([])).toThrow();
  });

  it("a renamed ancestor changes every path below it", () => {
    const renamed = pages(home, { ...about, slug: "company" }, team, people);
    expect(pathFromChain(parentChain("people", renamed))).toBe("/company/team/people");
  });

  it("a loop, or a missing parent, has no path", () => {
    const loop = pages({ id: "a", slug: "a", parentId: "b" }, { id: "b", slug: "b", parentId: "c" }, { id: "c", slug: "c", parentId: "a" });
    expect(() => parentChain("a", loop)).toThrow(ParentChainError);
    expect(() => parentChain("a", loop)).toThrow(expect.objectContaining({ reason: "cycle" }));
    expect(() => parentChain("self", pages({ id: "self", slug: "self", parentId: "self" }))).toThrow(expect.objectContaining({ reason: "cycle" }));
    expect(() => parentChain("orphan", pages({ id: "orphan", slug: "orphan", parentId: "gone" }))).toThrow(expect.objectContaining({ reason: "missing" }));
    expect(() => parentChain("nobody", find)).toThrow(expect.objectContaining({ reason: "missing" }));
  });

  it("a page cannot be put below itself or below its own descendants; anywhere else is fine", () => {
    expect(wouldCreateCycle("about", "about", find)).toBe(true);
    expect(wouldCreateCycle("about", "team", find)).toBe(true);
    expect(wouldCreateCycle("about", "people", find)).toBe(true);
    expect(wouldCreateCycle("people", "about", find)).toBe(false);
    expect(wouldCreateCycle("team", "contact", find)).toBe(false);
    expect(wouldCreateCycle("team", null, find)).toBe(false);
    // An already broken chain above the new parent is a loop too.
    expect(wouldCreateCycle("x", "a", pages({ id: "a", slug: "a", parentId: "b" }, { id: "b", slug: "b", parentId: "a" }))).toBe(true);
    expect(() => wouldCreateCycle("x", "gone", find)).toThrow(expect.objectContaining({ reason: "missing" }));
  });
});

describe("reserved paths", () => {
  const page = { type: "page" as const, blogPath: "blog" };
  const post = { type: "post" as const, blogPath: "blog" };

  it("the platform's paths, and everything under /_forge, on every site and for every type", () => {
    expect(RESERVED_PATHS).toEqual(["/_forge", "/sitemap.xml", "/robots.txt"]);
    for (const path of ["/_forge", "/_forge/preview/abc", "/sitemap.xml", "/robots.txt"]) {
      expect(reservedPathReason(path, page), path).toBe("That address is used by Forge on every site.");
      expect(reservedPathReason(path, post), path).toBe("That address is used by Forge on every site.");
    }
  });

  it("a page may not take the blog's path or anything under it; posts live there", () => {
    for (const path of ["/blog", "/blog/hello", "/blog/category/news", "/blog/page/2"]) expect(reservedPathReason(path, page), path).toBe("That address belongs to the blog (/blog).");
    expect(reservedPathReason("/blog/hello", post)).toBeNull();
    expect(reservedPathReason("/news", { type: "page", blogPath: "news" })).toBe("That address belongs to the blog (/news).");
    expect(reservedPathReason("/blog", { type: "page", blogPath: "news" })).toBeNull();
  });

  it("look-alikes, nested lookalikes and the Home page are free", () => {
    for (const path of ["/", "/blogs", "/blog-archive", "/about/blog", "/forge", "/sitemap", "/sitemap-xml", "/robots", "/robots-txt", "/s"]) {
      expect(reservedPathReason(path, page), path).toBeNull();
    }
  });
});
