import { describe, expect, it } from "vitest";
import { hasListFilters, listHref, parsePageQuery, parsePostQuery } from "./list-query";

/** What the pages and posts lists were asked for (M5-7): anything malformed is dropped, never an error. */

const ID = "0192f000-0000-7000-8000-000000000002";

describe("the lists' queries", () => {
  it("keeps what is well formed", () => {
    expect(parsePageQuery({ q: "  About  ", status: "published" })).toEqual({ q: "About", status: "published" });
    expect(parsePostQuery({ q: "bread", status: "draft", category: ID.toUpperCase(), author: ID, sort: "title", page: "3" })).toEqual({
      q: "bread", status: "draft", category: ID, author: ID, sort: "title", page: 3,
    });
  });

  it("drops the rest: unknown statuses and sorts, ids that are not ids, absurd pages, arrays, prototype keys", () => {
    expect(parsePageQuery({ q: "   ", status: "trashed" })).toEqual({});
    expect(parsePostQuery({ status: "PUBLISHED", category: "1 or 1=1", author: "'; drop table", sort: "__proto__", page: "-1" })).toEqual({ sort: "updated", page: 1 });
    expect(parsePostQuery({ sort: "constructor", page: "1.5" })).toEqual({ sort: "updated", page: 1 });
    expect(parsePostQuery({ page: "100000" }).page).toBe(1);
    expect(parsePostQuery({ q: ["first", "second"], status: ["published", "draft"] })).toMatchObject({ q: "first", status: "published" });
    expect(parsePostQuery({ q: "x".repeat(500) }).q).toHaveLength(100);
  });

  it("a list's URL leaves out the defaults; page 1 is the plain path", () => {
    expect(listHref("/acme/sites/bakery/posts", { sort: "updated", page: 1 })).toBe("/acme/sites/bakery/posts");
    expect(listHref("/p", { q: "a b", status: "draft", sort: "title", page: 1 }, { page: 2 })).toBe("/p?q=a+b&status=draft&sort=title&page=2");
    expect(hasListFilters({ sort: "title", page: 2 })).toBe(false);
    expect(hasListFilters({ author: ID })).toBe(true);
  });
});
