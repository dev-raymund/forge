import { describe, expect, it } from "vitest";
import { createEntrySchema, draftSchema, ENTRY_TERMS_MAX, typedSlug, versionSchema } from "./validation";

/** What the entry services accept (M5-3), before anything is looked up. */

const ID = "01920000-0000-7000-8000-000000000001";
const errorsOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.success ? null : result.error!.issues.map((issue) => `${issue.path.join(".") || "_"}: ${issue.message}`);

describe("createEntry's input", () => {
  it("a type and a title; the parent, template and author are optional; the title is trimmed and may be empty", () => {
    expect(createEntrySchema.parse({ type: "page" })).toEqual({ type: "page", title: "", parentId: null, template: null, authorId: null });
    expect(createEntrySchema.parse({ type: "post", title: "  Hello  ", parentId: ID, template: "full-width", authorId: ID })).toEqual({
      type: "post", title: "Hello", parentId: ID, template: "full-width", authorId: ID,
    });
  });

  it("refuses fields it does not have (ids, paths, statuses), a long title, ids that are not ids, a template that is not a key", () => {
    for (const input of [
      { type: "page", organizationId: ID }, { type: "page", siteId: ID }, { type: "page", path: "/" }, { type: "page", status: "published" }, { type: "page", slug: "x" },
      { type: "page", title: "x".repeat(201) }, { type: "page", parentId: "1" }, { type: "page", authorId: "admin" }, { type: "page", template: "../evil" },
      { type: "page", template: "Landing" },
    ]) {
      expect(createEntrySchema.safeParse(input).success, JSON.stringify(input).slice(0, 80)).toBe(false);
    }
  });
});

describe("a typed slug", () => {
  it("used as typed when it is a slug; otherwise one message saying why, never a suffix", () => {
    expect(typedSlug.parse("  about-us ")).toBe("about-us");
    expect(errorsOf(typedSlug.safeParse(""))).toEqual(["_: Enter a slug."]);
    expect(errorsOf(typedSlug.safeParse("x".repeat(101)))).toEqual(["_: Use at most 100 characters."]);
    for (const slug of ["About", "a--b", "-a", "a-", "a_b", "a.b", "a/b", "ü", "a b"]) {
      expect(errorsOf(typedSlug.safeParse(slug)), slug).toEqual(["_: Use lowercase letters, numbers and single hyphens, like about-us."]);
    }
  });
});

describe("saveDraft's draft", () => {
  it("only the fields being changed, each checked; the document is checked by parseDocument, not here", () => {
    expect(draftSchema.parse({})).toEqual({});
    expect(draftSchema.parse({ title: " T ", content: { anything: true }, termIds: [ID], featuredMediaId: null, template: null })).toEqual({
      title: "T", content: { anything: true }, termIds: [ID], featuredMediaId: null, template: null,
    });
  });

  it("refuses what cannot be changed through a draft, duplicate or too many terms, and malformed values", () => {
    for (const input of [
      { path: "/x" }, { status: "published" }, { authorId: ID }, { parentId: ID }, { version: 2 }, { organizationId: ID }, { seo: {} }, { type: "post" },
      { termIds: [ID, ID] }, { termIds: Array.from({ length: ENTRY_TERMS_MAX + 1 }, (_, i) => `01920000-0000-7000-8000-${String(i).padStart(12, "0")}`) },
      { termIds: ["x"] }, { featuredMediaId: "x" }, { excerpt: "x".repeat(1_001) }, { slug: "Not A Slug" }, { fields: [] },
    ]) {
      expect(draftSchema.safeParse(input).success, JSON.stringify(input).slice(0, 80)).toBe(false);
    }
  });
});

describe("a draft version", () => {
  it("a whole number from 1, as a number or as the form's string", () => {
    expect(versionSchema.parse("3")).toBe(3);
    expect(versionSchema.parse(7)).toBe(7);
    for (const version of ["", "0", "-1", "1.5", "two", null, 2 ** 31]) expect(versionSchema.safeParse(version).success, String(version)).toBe(false);
  });
});
