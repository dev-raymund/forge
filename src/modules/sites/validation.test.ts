import { describe, expect, it } from "vitest";
import { DEFAULT_SITE_LANGUAGE, DEFAULT_SITE_TIME_ZONE, isSiteTimeZone, languageLabel, SITE_LANGUAGES, siteTimeZones } from "./locale";
import { changeSiteAddressSchema, createSiteSchema } from "./validation";

const valid = { name: "Acme Bakery", address: "acme", language: "en", timezone: "UTC" };
const errorsOf = (input: unknown) => {
  const result = createSiteSchema.safeParse(input);
  return result.success ? {} : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join("."), issue.message]));
};

describe("the create-site form's rules (shared by the browser and the server)", () => {
  it("accepts a site, with the address in its one spelling and the name trimmed", () => {
    expect(createSiteSchema.parse({ ...valid, name: "  Acme Bakery ", address: " ACME " })).toEqual({ ...valid, address: "acme" });
  });

  it("names the field that is wrong", () => {
    expect(errorsOf({ ...valid, name: " " })).toEqual({ name: "Enter a name for the site." });
    expect(errorsOf({ ...valid, name: "x".repeat(81) })).toEqual({ name: "Use at most 80 characters." });
    expect(errorsOf({ ...valid, address: "www" })).toEqual({ address: "That address is reserved. Choose another." });
    expect(errorsOf({ ...valid, language: "xx" })).toEqual({ language: "Choose a language." });
    expect(errorsOf({ ...valid, timezone: "Mars/Base" })).toEqual({ timezone: "Choose a time zone from the list." });
    expect(errorsOf({})).toMatchObject({ address: "Enter an address for the site.", language: "Choose a language.", timezone: "Choose a time zone." });
  });

  it("the address form has the same address rule", () => {
    expect(changeSiteAddressSchema.parse({ address: " Acme-2 " })).toEqual({ address: "acme-2" });
    expect(changeSiteAddressSchema.safeParse({ address: "admin" }).success).toBe(false);
  });
});

describe("languages and time zones", () => {
  it("offers each language once, as a canonical BCP 47 tag, English first, and none written right to left (the themes do not lay those out yet)", () => {
    const codes = SITE_LANGUAGES.map((language) => language.code);
    expect(codes[0]).toBe(DEFAULT_SITE_LANGUAGE);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(Intl.getCanonicalLocales(code), code).toEqual([code]);
    for (const rtl of ["ar", "he", "fa", "ur"]) expect(codes).not.toContain(rtl);
    expect(languageLabel("fil")).toBe("Filipino");
    expect(languageLabel("zz")).toBe("zz");
  });

  it("time zones are this runtime's IANA list, UTC first, exactly as spelled", () => {
    const zones = siteTimeZones();
    expect(zones[0]).toBe(DEFAULT_SITE_TIME_ZONE);
    expect(zones).toEqual(expect.arrayContaining(["Asia/Manila", "Europe/Berlin", "America/New_York"]));
    expect(new Set(zones).size).toBe(zones.length);
    for (const zone of ["UTC", "Asia/Manila"]) expect(isSiteTimeZone(zone), zone).toBe(true);
    for (const zone of ["utc", "asia/manila", "+05:00", "Mars/Base", "", 7, null]) expect(isSiteTimeZone(zone), String(zone)).toBe(false);
  });
});
