import { describe, expect, it } from "vitest";
import { ENTRY_SLUG_MAX, FALLBACK_SLUG, isEntrySlug, nextFreeSlug, slugFromTitle, slugWithSuffix } from "./slugs";

/** The `entries_slug_format` CHECK, as the database has it (migration 0001). */
const DATABASE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("entry slugs", () => {
  it("a slug from a title is never empty and always one the database accepts", () => {
    const titles = ["About us", "", "   ", "中文", "!!!", "Ünïcödé", "a".repeat(500), `${"word ".repeat(40)}end`, "x-".repeat(80), "Home", "-"];
    for (const title of titles) {
      const slug = slugFromTitle(title);
      expect(slug, title).toMatch(DATABASE_SLUG);
      expect(slug.length, title).toBeLessThanOrEqual(ENTRY_SLUG_MAX);
      expect(isEntrySlug(slug), title).toBe(true);
    }
    expect(slugFromTitle("中文")).toBe(FALLBACK_SLUG);
    expect(slugFromTitle("")).toBe("untitled");
  });

  it("isEntrySlug: the database's format and the length", () => {
    for (const slug of ["a", "about", "about-us", "2026", "a1-b2-c3", "x".repeat(ENTRY_SLUG_MAX)]) expect(isEntrySlug(slug), slug).toBe(true);
    for (const slug of ["", "About", "a--b", "-a", "a-", "a_b", "a.b", "a/b", " a", "ü", "x".repeat(ENTRY_SLUG_MAX + 1)]) expect(isEntrySlug(slug), slug).toBe(false);
  });

  it("candidates: base, base-2, base-3, …, each a slug that fits", () => {
    expect([1, 2, 3, 10].map((n) => slugWithSuffix("about", n))).toEqual(["about", "about-2", "about-3", "about-10"]);
    expect(slugWithSuffix("about", 0)).toBe("about");
    const long = "a".repeat(ENTRY_SLUG_MAX);
    expect(slugWithSuffix(long, 2)).toBe(`${"a".repeat(ENTRY_SLUG_MAX - 2)}-2`);
    expect(slugWithSuffix(long, 123)).toHaveLength(ENTRY_SLUG_MAX);
    // A cut that would leave a hyphen before the suffix loses the hyphen.
    const hyphenAtCut = `${"a".repeat(ENTRY_SLUG_MAX - 3)}-bb`;
    expect(slugWithSuffix(hyphenAtCut, 2)).toBe(`${"a".repeat(ENTRY_SLUG_MAX - 3)}-2`);
    for (const n of [2, 9, 99, 1000]) expect(isEntrySlug(slugWithSuffix(hyphenAtCut, n)), String(n)).toBe(true);
  });

  it("the first free candidate: gaps are reused; skipped candidates are passed over; it can start further on", () => {
    expect(nextFreeSlug("about", [])).toBe("about");
    expect(nextFreeSlug("about", ["about"])).toBe("about-2");
    expect(nextFreeSlug("about", ["about", "about-2", "about-4"])).toBe("about-3");
    expect(nextFreeSlug("about", ["about-2"])).toBe("about");
    expect(nextFreeSlug("blog", [], (slug) => slug === "blog")).toBe("blog-2");
    expect(nextFreeSlug("about", [], () => false, 5)).toBe("about-5");
    // Unrelated slugs that merely start the same do not count.
    expect(nextFreeSlug("about", ["about-us", "about-2x", "abouts"])).toBe("about");
  });

  it("gives up instead of looping when nothing could ever be free", () => {
    expect(() => nextFreeSlug("about", [], () => true)).toThrow(/No free slug/);
  });
});
