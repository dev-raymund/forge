import { describe, expect, it } from "vitest";
import { isPermission } from "@/modules/tenancy";
import { ENTRY_TYPES } from "@/platform/db/schema";
import { isEntryPath, reservedPathReason } from "../paths";
import { CONTENT_TYPE_KEYS, CONTENT_TYPES, contentType, isContentTypeKey } from "./registry";

const BLOG = { blogPath: "blog" };

describe("the content-type registry (plan §5)", () => {
  it("page and post: the same keys as the table's CHECK, once each", () => {
    expect([...CONTENT_TYPE_KEYS].sort()).toEqual([...ENTRY_TYPES].sort());
    expect(new Set(CONTENT_TYPE_KEYS).size).toBe(CONTENT_TYPES.length);
  });

  it("a type is found by its exact key; anything else finds nothing", () => {
    expect(contentType("page")?.label).toEqual({ singular: "Page", plural: "Pages" });
    expect(contentType("post")?.label).toEqual({ singular: "Post", plural: "Posts" });
    for (const key of ["Page", "POST", " page", "pages", "product", "__proto__", "constructor", "toString", "", null, undefined, 1, {}]) {
      expect(contentType(key), String(key)).toBeNull();
      expect(isContentTypeKey(key), String(key)).toBe(false);
    }
  });

  it("what each type supports (plan §5's table): pages nest and take templates; posts have excerpts, featured images, categories and tags", () => {
    expect(contentType("page")).toMatchObject({
      hierarchical: true, supports: { excerpt: false, featuredImage: false, taxonomies: [], templates: true }, seoDefaults: { schemaType: "WebPage" },
    });
    expect(contentType("post")).toMatchObject({
      hierarchical: false, supports: { excerpt: true, featuredImage: true, taxonomies: ["category", "tag"], templates: false }, seoDefaults: { schemaType: "BlogPosting" },
    });
  });

  it("each type's permission keys are in the catalog (ADR 0009), so a key built from the registry is always a real one", () => {
    for (const type of CONTENT_TYPES) {
      expect(type.permissionsKey).toBe(`entries.${type.key}`);
      for (const action of ["read", "create"]) expect(isPermission(`${type.permissionsKey}.${action}`), `${type.key} ${action}`).toBe(true);
    }
    for (const action of ["update", "publish", "delete"]) expect(isPermission(`entries.page.${action}`), action).toBe(true);
    for (const action of ["update.own", "update.any", "publish.own", "publish.any", "delete.own", "delete.any"]) expect(isPermission(`entries.post.${action}`), action).toBe(true);
  });

  it("neither type has extra fields yet: the empty object only", () => {
    for (const type of CONTENT_TYPES) {
      expect(type.fields.safeParse({}).success, type.key).toBe(true);
      expect(type.fields.safeParse({ price: 1 }).success, type.key).toBe(false);
      expect(type.fields.safeParse(null).success, type.key).toBe(false);
    }
  });

  it("routing: pages from their parent's path, Home at `/`; posts from the blog's path, never at `/` and never under a parent", () => {
    const page = contentType("page")!;
    const post = contentType("post")!;
    expect(page.routing({ slug: "about" }, BLOG)).toBe("/about");
    expect(page.routing({ slug: "team", parentPath: "/about" }, BLOG)).toBe("/about/team");
    expect(page.routing({ slug: "home", home: true }, BLOG)).toBe("/");
    expect(post.routing({ slug: "hello" }, BLOG)).toBe("/blog/hello");
    expect(post.routing({ slug: "hello" }, { blogPath: "news" })).toBe("/news/hello");
    expect(post.routing({ slug: "hello", home: true, parentPath: "/about" }, BLOG)).toBe("/blog/hello");
  });

  it("every routed path is one the database accepts; a post's is never reserved for posts", () => {
    for (const slug of ["a", "about", "hello-world", "x".repeat(100)]) {
      for (const parentPath of [null, "/", "/about", "/a/b/c"]) expect(isEntryPath(contentType("page")!.routing({ slug, parentPath }, BLOG)), `${parentPath} ${slug}`).toBe(true);
      const postPath = contentType("post")!.routing({ slug }, BLOG);
      expect(isEntryPath(postPath), slug).toBe(true);
      expect(reservedPathReason(postPath, { type: "post", ...BLOG }), slug).toBeNull();
    }
  });
});
