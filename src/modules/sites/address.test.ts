import { describe, expect, it } from "vitest";
import { isSiteAddress } from "@/platform/routing/hosts";
import { checkSiteAddress, RESERVED_SITE_ADDRESSES, RESERVED_SITE_SLUGS, SITE_ADDRESS_MAX, siteSlugFor, suggestSiteAddress } from "./address";

/** The address rules of M4-1 (ADR 0011): one spelling, the shape of a DNS label, a short reserved list. */

const ok = (input: string) => checkSiteAddress(input);
const accepted = (input: string) => {
  const checked = ok(input);
  return checked.ok ? checked.address : null;
};

describe("a site address", () => {
  it("has one spelling: trimmed and lowercased before anything else", () => {
    expect(accepted("acme")).toBe("acme");
    expect(accepted("  Acme-Studio \t")).toBe("acme-studio");
    expect(accepted("ACME2")).toBe("acme2");
  });

  it("is a DNS label: 1 to 63 lowercase letters, digits and single hyphens, never at either end", () => {
    for (const valid of ["a", "7", "ab", "acme", "a1-b2", "123", "x".repeat(SITE_ADDRESS_MAX), "a-b-c-d"]) expect(accepted(valid), valid).toBe(valid);
    for (const invalid of ["-acme", "acme-", "-", "a--b", "ac---me", "a_b", "acme.com", "acme/x", "acme x", "acme!", "<b>", "x".repeat(SITE_ADDRESS_MAX + 1)]) {
      expect(ok(invalid).ok, invalid).toBe(false);
    }
  });

  it("is the shape the router already accepts after /s/: what can be created can be visited, and nothing else", () => {
    for (const input of ["acme", "a", "x".repeat(63), "a-b", "-a", "a--b", "a_b", "Acme"]) {
      const checked = ok(input);
      if (checked.ok) expect(isSiteAddress(checked.address), input).toBe(true);
      else if (input === input.trim().toLowerCase()) expect(isSiteAddress(input) && !RESERVED_SITE_ADDRESSES.has(input), input).toBe(false);
    }
  });

  it("refuses letters outside ASCII instead of converting them, and punycode typed in, so no address can pass for another", () => {
    for (const lookalike of ["café", "аcme" /* Cyrillic а */, "ａｃｍｅ" /* full width */, "acmé", "xn--caf-dma", "xn--80ak6aa92e", "straße", "İstanbul"]) {
      expect(ok(lookalike).ok, lookalike).toBe(false);
    }
  });

  it("is never one of the labels the platform keeps for itself", () => {
    expect([...RESERVED_SITE_ADDRESSES].sort()).toEqual(["admin", "api", "app", "media", "www"]);
    for (const reserved of [...RESERVED_SITE_ADDRESSES, "WWW", " Api "]) {
      expect(ok(reserved), reserved).toEqual({ ok: false, message: "That address is reserved. Choose another." });
    }
  });

  it("says what is wrong, in words", () => {
    expect(ok("")).toEqual({ ok: false, message: "Enter an address for the site." });
    expect(ok("   ")).toEqual({ ok: false, message: "Enter an address for the site." });
    expect(ok("x".repeat(64))).toEqual({ ok: false, message: "Use at most 63 characters." });
    expect(ok("a--b")).toEqual({ ok: false, message: "Use lowercase letters, numbers and single hyphens, not at the start or end, e.g. acme-studio." });
  });
});

describe("an address suggested from a site's name", () => {
  it("is the name in lowercase letters, digits and single hyphens", () => {
    expect(suggestSiteAddress("Acme Bakery")).toBe("acme-bakery");
    expect(suggestSiteAddress("Café Acme & Co.")).toBe("cafe-acme-and-co");
    expect(suggestSiteAddress("  --Hello,   World!--  ")).toBe("hello-world");
    expect(suggestSiteAddress("xn--bcher")).toBe("xn-bcher");
    expect(suggestSiteAddress("日本語")).toBe("");
    expect(suggestSiteAddress(`${"long ".repeat(30)}`).length).toBeLessThanOrEqual(SITE_ADDRESS_MAX);
  });

  it("is only a suggestion: whatever it gives, the rules still decide", () => {
    for (const name of ["Acme Bakery", "WWW", "Café & Co.", "a".repeat(100), "!!!", "Ünïcödé Shop"]) {
      const suggestion = suggestSiteAddress(name);
      expect(suggestion, name).not.toMatch(/--|^-|-$/);
      if (suggestion) expect(ok(suggestion).ok || RESERVED_SITE_ADDRESSES.has(suggestion), name).toBe(true);
    }
  });
});

describe("a new site's slug", () => {
  it("is its address, unless that slug is held or is a page of the sites area: then a number is added", () => {
    expect(siteSlugFor("acme", new Set())).toBe("acme");
    expect(siteSlugFor("acme", new Set(["acme"]))).toBe("acme-2");
    expect(siteSlugFor("acme", new Set(["acme", "acme-2", "acme-3"]))).toBe("acme-4");
    expect(siteSlugFor("new", new Set())).toBe("new-2");
    expect([...RESERVED_SITE_SLUGS]).toEqual(["new"]);
  });

  it("stays within 63 characters, with no hyphen before the number doubled", () => {
    const long = "a".repeat(62) + "b";
    expect(siteSlugFor(long, new Set([long]))).toBe(`${"a".repeat(61)}-2`);
    const hyphened = `${"a".repeat(60)}-bc`;
    const slug = siteSlugFor(hyphened, new Set([hyphened]));
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug).not.toContain("--");
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/); // the table's CHECK
  });
});
