import { describe, expect, it } from "vitest";
import { createTermSchema, updateTermSchema } from "./validation";

/** What the term services accept (M5-8): checked here, and again by the database's constraints. */

describe("a new term", () => {
  it("a name; a slug as typed, or none (one is made from the name); a description; a parent", () => {
    expect(createTermSchema.parse({ taxonomy: "tag", name: "  Rye  " })).toEqual({ taxonomy: "tag", name: "Rye", slug: null, description: "", parentId: null });
    expect(createTermSchema.parse({ taxonomy: "tag", name: "Rye", slug: "" }).slug).toBeNull();
    expect(createTermSchema.parse({ taxonomy: "category", name: "Rye", slug: "dark-rye", description: " Heavy ", parentId: "0192f000-0000-7000-8000-000000000002" })).toMatchObject({
      slug: "dark-rye", description: "Heavy",
    });
  });

  it.each([
    [{ name: "" }, "name"],
    [{ name: "x".repeat(101) }, "name"],
    [{ name: "Rye", slug: "Dark Rye" }, "slug"],
    [{ name: "Rye", slug: "dark--rye" }, "slug"],
    [{ name: "Rye", slug: "x".repeat(101) }, "slug"],
    [{ name: "Rye", description: "x".repeat(501) }, "description"],
    [{ name: "Rye", parentId: "not-an-id" }, "parentId"],
    [{ name: "Rye", organizationId: "0192f000-0000-7000-8000-000000000002" }, ""],
  ])("refuses %j", (input, field) => {
    const result = createTermSchema.safeParse({ taxonomy: "tag", ...input });
    expect(result.success).toBe(false);
    if (field) expect(result.error!.issues.map((issue) => issue.path[0])).toContain(field);
  });
});

describe("a change to a term", () => {
  it("only what is sent; a parent of null takes a category to the top level; nothing about the site", () => {
    expect(updateTermSchema.parse({ name: "Loaves" })).toEqual({ name: "Loaves" });
    expect(updateTermSchema.parse({ parentId: null })).toEqual({ parentId: null });
    expect(updateTermSchema.safeParse({ slug: "" }).success).toBe(false);
    expect(updateTermSchema.safeParse({ siteId: "0192f000-0000-7000-8000-000000000002" }).success).toBe(false);
  });
});
