import { describe, expect, it } from "vitest";
import { dateLabel } from "./dates";
import { listPageHref, routeFor } from "./routes";
import { blogRouteOf } from "@/modules/seo/shared";

/** From a public path to what it may name (M5-6, plan §10). */

const at = (path: string, blogPath = "blog") => routeFor(path === "/" ? [] : path.slice(1).split("/"), blogPath);

describe("routeFor", () => {
  it("the home, pages and posts are their stored paths, exactly", () => {
    expect(at("/")).toEqual({ kind: "path", path: "/" });
    expect(at("/about")).toEqual({ kind: "path", path: "/about" });
    expect(at("/about/team/leaders")).toEqual({ kind: "path", path: "/about/team/leaders" });
    expect(at("/blog/hello-world")).toEqual({ kind: "path", path: "/blog/hello-world" });
    expect(at("/news/hello-world")).toEqual({ kind: "path", path: "/news/hello-world" }); // a post from before the blog's path changed
  });

  it("the blog's index, its archives and their pages", () => {
    expect(at("/blog")).toEqual({ kind: "blog-index", page: 1 });
    expect(at("/blog/page/2")).toEqual({ kind: "blog-index", page: 2 });
    expect(at("/blog/category/bread")).toEqual({ kind: "term-archive", taxonomy: "category", slug: "bread", page: 1 });
    expect(at("/blog/tag/rye/page/12")).toEqual({ kind: "term-archive", taxonomy: "tag", slug: "rye", page: 12 });
    expect(at("/news", "news")).toEqual({ kind: "blog-index", page: 1 });
    expect(at("/blog", "news")).toEqual({ kind: "path", path: "/blog" }); // not the blog any more: only a page could be there
  });

  it("a post may be called page, category or tag: two segments are always a post", () => {
    expect(at("/blog/page")).toEqual({ kind: "path", path: "/blog/page" });
    expect(at("/blog/category")).toEqual({ kind: "path", path: "/blog/category" });
    expect(at("/blog/category/bread/extra")).toEqual({ kind: "path", path: "/blog/category/bread/extra" });
  });

  it("one spelling per address: page 1 and badly written page numbers name nothing", () => {
    for (const path of ["/blog/page/1", "/blog/page/0", "/blog/page/01", "/blog/page/-2", "/blog/page/2x", "/blog/page/100000", "/blog/tag/rye/page/1", "/blog/tag/rye/page/x"]) {
      expect(at(path), path).toBeNull();
    }
  });

  it("only stored-path segments: capitals, spaces, dots, encoded slashes and empty segments name nothing", () => {
    for (const segments of [["About"], ["about us"], ["a.b"], ["sitemap.xml"], ["_forge", "preview"], ["a/b"], [""], ["a", ""], ["-a"], ["a-"], ["a--b"], ["%2e%2e"], [".."]]) {
      expect(routeFor(segments, "blog"), segments.join("|")).toBeNull();
    }
  });

  it("nothing absurdly deep or long is looked up", () => {
    expect(routeFor(Array.from({ length: 17 }, () => "a"), "blog")).toBeNull();
    expect(routeFor(["a".repeat(1_100)], "blog")).toBeNull();
    expect(routeFor(Array.from({ length: 16 }, () => "a"), "blog")).toEqual({ kind: "path", path: `/${Array.from({ length: 16 }, () => "a").join("/")}` });
  });

  it("a list's pages: page 1 is the list itself", () => {
    expect([1, 2, 3].map((page) => listPageHref("/s/acme/blog", page))).toEqual(["/s/acme/blog", "/s/acme/blog/page/2", "/s/acme/blog/page/3"]);
  });
});

describe("dateLabel", () => {
  it("in the site's language and time zone, with the exact instant", () => {
    expect(dateLabel("2026-09-30T23:30:00.000Z", "en", "UTC")).toEqual({ iso: "2026-09-30T23:30:00.000Z", label: "September 30, 2026" });
    expect(dateLabel("2026-09-30T23:30:00.000Z", "en", "Asia/Manila")?.label).toBe("October 1, 2026");
    expect(dateLabel("2026-09-30T23:30:00.000Z", "de", "UTC")?.label).toBe("30. September 2026");
  });

  it("no date, or a broken one, is none; an unknown zone or language falls back to English and UTC", () => {
    expect(dateLabel(null, "en", "UTC")).toBeNull();
    expect(dateLabel("not a date", "en", "UTC")).toBeNull();
    expect(dateLabel("2026-09-30T23:30:00.000Z", "en", "Mars/Olympus")?.label).toBe("September 30, 2026");
    expect(dateLabel("2026-09-30T23:30:00.000Z", "not a language!", "UTC")?.label).toBe("September 30, 2026");
  });
});

// M8-5: the redirects' services decide which addresses the blog holds with `blogRouteOf` (seo); it must agree with
// the router here, or a redirect could be written over a list page, or refused for an address the blog does not have.
describe("the redirects' view of the blog's routes agrees with routeFor", () => {
  const paths = [
    "/blog", "/blog/page/2", "/blog/page/1", "/blog/page/02", "/blog/category/bread", "/blog/tag/rye", "/blog/category/bread/page/3", "/blog/category/bread/page/1",
    "/blog/rye-season", "/blog/category", "/blog/category/bread/extra", "/news", "/about", "/blog/Category/bread", "/blog/category/bread/page", "/blog/page/100000",
  ];
  it.each(paths)("%s", (path) => {
    const route = routeFor(path.slice(1).split("/"), "blog");
    const expected = !route || route.kind === "path" ? null : route.kind === "blog-index" ? (route.page === 1 ? "index" : "list-page") : route.page === 1 ? "archive" : "list-page";
    expect(blogRouteOf(path, "blog")?.kind ?? null).toBe(expected);
  });
});
