import { describe, expect, it } from "vitest";
import { slugify } from "./slugify";

describe("slugify", () => {
  it.each([
    ["About us", "about-us"],
    ["  Hello,   World!  ", "hello-world"],
    ["Über uns & Kontakt", "uber-uns-and-kontakt"],
    ["Crème brûlée à la carte", "creme-brulee-a-la-carte"],
    ["Straße", "strasse"],
    ["Æsir, Øresund, Œuvre, Łódź, Đorđe, Þór", "aesir-oresund-oeuvre-lodz-dorde-thor"],
    ["İstanbul", "istanbul"],
    ["10 tips for 2026", "10-tips-for-2026"],
    ["C++ & C#", "c-and-c"],
    ["--leading and trailing--", "leading-and-trailing"],
    ["a_b.c/d\\e", "a-b-c-d-e"],
    ["<script>alert(1)</script>", "script-alert-1-script"],
    ["'; drop table entries; --", "drop-table-entries"],
    ["../../etc/passwd", "etc-passwd"],
    ["Ｆｕｌｌｗｉｄｔｈ", "fullwidth"],
  ])("%j → %j", (text, slug) => {
    expect(slugify(text, 100)).toBe(slug);
  });

  it("scripts without a Latin spelling, and text without letters or digits, give an empty slug", () => {
    for (const text of ["中文标题", "Ελληνικά", "Русский", "日本語", "🎉🎉", "!!!", "", "   ", "&"]) {
      expect(slugify(text, 100), text).toBe(text === "&" ? "and" : "");
    }
  });

  it("never longer than asked, and never ending with a hyphen when cut", () => {
    expect(slugify("a".repeat(150), 100)).toHaveLength(100);
    expect(slugify("abcd efgh", 5)).toBe("abcd");
    expect(slugify("abcd efgh", 6)).toBe("abcd-e");
    expect(slugify("anything", 0)).toBe("");
  });
});
