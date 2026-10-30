import { describe, expect, it } from "vitest";
import { RESERVED_PATHS } from "@/modules/content/shared";
import {
  archivePath, blogRouteOf, encodeSitePath, followRedirects, isPermanent, parseRedirectDestination, parseSitePath, planRedirectWrite, REDIRECT_DEPTH_MAX,
  REDIRECT_STATUSES, RESERVED_REDIRECT_PATHS, responseStatusOf,
} from "./shared";

/** M8-5 (ADR 0032): the redirects' address rules, loop detection and chain flattening, pure. */

const ok = (result: { ok: boolean; value?: unknown; message?: string }) => (result.ok ? result.value : `refused: ${result.message}`);
const map = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("a redirect's source", () => {
  it.each([
    ["/old-page", "/old-page"],
    ["  /old-page/  ", "/old-page"],
    ["/About-Us.html", "/About-Us.html"],
    ["/caf%C3%A9", "/café"],
    ["/café", "/café"],
    ["/my%20page", "/my page"],
    ["/index.php", "/index.php"],
    ["/a/b/c", "/a/b/c"],
  ])("%s is kept as %s: decoded, no trailing slash, case as typed", (input, value) => {
    expect(ok(parseSitePath(input, "source"))).toBe(value);
  });

  it.each([
    ["", "Enter the old address"],
    ["old-page", "Start with /"],
    ["https://example.com/old", "Start with /"],
    ["//evil.example/x", "Start with /"],
    ["/old?x=1", "without ?"],
    ["/old#top", "without ?"],
    ["/a//b", "single slashes"],
    ["/a%2Fb", "not %2F"],
    ["/a/../b", "without . or .."],
    ["/a/%2e%2e/b", "without . or .."],
    ["/bad%zz", "broken %-escape"],
    ["/tab\there", "as it is typed"],
    ["/a<b", "as it is typed"],
    ["/a%0Ab", "as it is typed"],
    ["/", "home page cannot be redirected"],
    ["/_forge/preview/x", "used by Forge"],
    ["/sitemap.xml", "used by Forge"],
    ["/robots.txt", "used by Forge"],
    [`/${"a/".repeat(17)}z`, "at most 16 parts"],
    [`/${"a".repeat(1_100)}`, "at most 1024 characters"],
  ])("%j is refused (%s)", (input, reason) => {
    expect(ok(parseSitePath(input, "source"))).toContain(reason);
  });

  it("never names Forge's own addresses: the same list as an entry's reserved paths", () => {
    expect(RESERVED_REDIRECT_PATHS).toEqual(RESERVED_PATHS);
  });
});

describe("a redirect's destination", () => {
  const app = "cms.example.com";
  it.each([
    ["/new-page", { kind: "path", value: "/new-page" }],
    ["/", { kind: "path", value: "/" }],
    ["/blog/", { kind: "path", value: "/blog" }],
    ["https://shop.example.com", { kind: "url", value: "https://shop.example.com/" }],
    ["HTTPS://Shop.Example.com/a?b=1#c", { kind: "url", value: "https://shop.example.com/a?b=1#c" }],
    ["http://old.example.org/page", { kind: "url", value: "http://old.example.org/page" }],
  ])("%s is %j", (input, value) => {
    expect(ok(parseRedirectDestination(input, app))).toEqual(value);
  });

  it.each([
    ["javascript:alert(1)", "full address starting with https://"],
    ["data:text/html,<script>alert(1)</script>", "full address starting with https://"],
    ["//evil.example/login", "full address starting with https://"],
    ["ftp://files.example.com/x", "full address starting with https://"],
    ["mailto:hi@example.com", "full address starting with https://"],
    ["shop.example.com", "full address starting with https://"],
    ["https://user:pw@example.com/", "user name or password"],
    ["https://cms.example.com/s/other-site", "on Forge itself"],
    ["https://CMS.example.com/login", "on Forge itself"],
    ["https://example.com/a b", "without spaces"],
    ['https://example.com/"onclick', "without spaces or quotes"],
    [`https://example.com/${"a".repeat(2_100)}`, "at most 2048"],
    ["/new?x=1", "without ?"],
    ["/a%2Fb", "not %2F"],
  ])("%j is refused (%s)", (input, reason) => {
    expect(ok(parseRedirectDestination(input, app))).toContain(reason);
  });
});

describe("loops and chains", () => {
  it("follows a chain to its end, and stops at an address elsewhere", () => {
    expect(followRedirects(map({ "/a": "/b", "/b": "/c" }), "/a")).toEqual({ kind: "end", destination: "/c", hops: 2 });
    expect(followRedirects(map({ "/a": "https://e.example/" }), "/a")).toEqual({ kind: "end", destination: "https://e.example/", hops: 1 });
    expect(followRedirects(map({}), "/a")).toEqual({ kind: "end", destination: "/a", hops: 0 });
    expect(followRedirects(map({ "/a": "/b", "/b": "/a" }), "/a")).toEqual({ kind: "loop" });
  });

  it("a redirect to itself, or whose destination leads back to it, is refused", () => {
    expect(planRedirectWrite(map({}), "/a", "/a")).toEqual({ ok: false, reason: "self" });
    expect(planRedirectWrite(map({ "/b": "/a" }), "/a", "/b")).toEqual({ ok: false, reason: "loop" });
    expect(planRedirectWrite(map({ "/b": "/c", "/c": "/d", "/d": "/a" }), "/a", "/b")).toEqual({ ok: false, reason: "loop" });
    // A cycle among others (written behind the services' back) is refused too, never followed forever.
    expect(planRedirectWrite(map({ "/b": "/c", "/c": "/b" }), "/a", "/b")).toEqual({ ok: false, reason: "loop" });
  });

  it(`a chain longer than ${REDIRECT_DEPTH_MAX} steps is refused; ${REDIRECT_DEPTH_MAX} is followed`, () => {
    const chain = (n: number) => map(Object.fromEntries(Array.from({ length: n }, (_, i) => [`/p${i}`, `/p${i + 1}`])));
    expect(planRedirectWrite(chain(REDIRECT_DEPTH_MAX), "/start", "/p0")).toMatchObject({ ok: true, destination: `/p${REDIRECT_DEPTH_MAX}` });
    expect(planRedirectWrite(chain(REDIRECT_DEPTH_MAX + 1), "/start", "/p0")).toEqual({ ok: false, reason: "too-long" });
  });

  it("A→B written while B→C exists stores A→C (one hop for visitors)", () => {
    expect(planRedirectWrite(map({ "/b": "/c" }), "/a", "/b")).toEqual({ ok: true, destination: "/c", flattened: true, rewrites: [] });
    expect(planRedirectWrite(map({ "/b": "https://e.example/x" }), "/a", "/b")).toEqual({ ok: true, destination: "https://e.example/x", flattened: true, rewrites: [] });
  });

  it("B→C written while A→B exists points A straight at C; and at the end of C's chain", () => {
    expect(planRedirectWrite(map({ "/a": "/b", "/x": "/b", "/y": "/z" }), "/b", "/c")).toEqual({
      ok: true, destination: "/c", flattened: false, rewrites: [{ source: "/a", destination: "/c" }, { source: "/x", destination: "/c" }],
    });
    expect(planRedirectWrite(map({ "/a": "/b", "/c": "/d" }), "/b", "/c")).toEqual({ ok: true, destination: "/d", flattened: true, rewrites: [{ source: "/a", destination: "/d" }] });
  });

  it("to an address elsewhere: no chain to follow, and those that ended here end there", () => {
    expect(planRedirectWrite(map({ "/a": "/b" }), "/b", "https://shop.example.com/")).toEqual({
      ok: true, destination: "https://shop.example.com/", flattened: false, rewrites: [{ source: "/a", destination: "https://shop.example.com/" }],
    });
  });
});

describe("what visitors are sent", () => {
  it("a permanent code as 308, a temporary one as 307 (what a page can answer; the same for GET and HEAD)", () => {
    expect(REDIRECT_STATUSES.map((code) => [code, isPermanent(code), responseStatusOf(code)])).toEqual([
      [301, true, 308], [302, false, 307], [307, false, 307], [308, true, 308],
    ]);
  });

  it("a site path is encoded again for the Location header", () => {
    expect(encodeSitePath("/café/my page")).toBe("/caf%C3%A9/my%20page");
    expect(encodeSitePath("/about-us")).toBe("/about-us");
    expect(encodeSitePath("/")).toBe("/");
  });
});

describe("the blog's routes (rendering/routes.test.ts checks them against the public router)", () => {
  it("an archive's address", () => {
    expect(archivePath("news", "category", "bread")).toBe("/news/category/bread");
    expect(blogRouteOf("/news/tag/rye", "news")).toEqual({ kind: "archive", taxonomy: "tag", slug: "rye" });
  });
});
