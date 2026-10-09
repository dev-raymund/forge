import { describe, expect, it } from "vitest";
import {
  analyticsSettingsSchema, DEFAULT_BLOG_PATH, DEFAULT_POSTS_PER_PAGE, generalSettingsSchema, readAnalytics, readGeneral, readingSettingsSchema, readReading,
  SOCIAL_KEYS, socialLinks,
} from "./settings";

/** A site's settings (M4-2, ADR 0014): strict for what is submitted, lenient for what is stored. */

const general = { name: "Acme Bakery", tagline: "Fresh daily", language: "en", timezone: "UTC" };
const errorsOf = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } }, input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? {} : Object.fromEntries(result.error!.issues.map((issue) => [issue.path.join("."), issue.message]));
};

describe("general settings", () => {
  it("accept a site's name, tagline, language and time zone, and social links as https addresses; an empty link is none", () => {
    const parsed = generalSettingsSchema.parse({ ...general, name: "  Acme  ", instagram: "https://instagram.com/acme", x: "" });
    expect(parsed).toEqual({ ...general, name: "Acme", instagram: "https://instagram.com/acme", x: undefined });
  });

  it("refuse an empty name, a long tagline, an unknown language or time zone", () => {
    expect(errorsOf(generalSettingsSchema, { ...general, name: " " })).toEqual({ name: "Enter a name for the site." });
    expect(errorsOf(generalSettingsSchema, { ...general, tagline: "x".repeat(201) })).toEqual({ tagline: "Use at most 200 characters." });
    expect(errorsOf(generalSettingsSchema, { ...general, language: "xx" })).toEqual({ language: "Choose a language." });
    expect(errorsOf(generalSettingsSchema, { ...general, timezone: "Mars/Base" })).toEqual({ timezone: "Choose a time zone from the list." });
  });

  it("a social link is a full https address and nothing else", () => {
    for (const bad of ["javascript:alert(1)", "http://instagram.com/acme", "instagram.com/acme", "https://localhost", "https://a b.com", 'https://x.com/"><script>', "data:text/html,x", "x".repeat(301)]) {
      expect(errorsOf(generalSettingsSchema, { ...general, instagram: bad }), bad).toHaveProperty("instagram");
    }
  });

  it("refuse any field they do not have", () => {
    expect(generalSettingsSchema.safeParse({ ...general, organizationId: "x" }).success).toBe(false);
    expect(generalSettingsSchema.safeParse({ ...general, mastodon: "https://x.y/z" }).success).toBe(false);
  });
});

describe("reading settings", () => {
  it("a blog path is one lowercase segment; posts per page a whole number from 1 to 50", () => {
    expect(readingSettingsSchema.parse({ blogPath: " News ", postsPerPage: "12" })).toEqual({ blogPath: "news", postsPerPage: 12 });
    for (const blogPath of ["", "my blog", "my/blog", "-blog", "blog-", "my--blog", "_forge", "blog.xml", "x".repeat(41)]) {
      expect(errorsOf(readingSettingsSchema, { blogPath, postsPerPage: "10" }), blogPath).toHaveProperty("blogPath");
    }
    for (const postsPerPage of ["0", "51", "2.5", "ten", "-1", ""]) {
      expect(errorsOf(readingSettingsSchema, { blogPath: "blog", postsPerPage }), postsPerPage).toHaveProperty("postsPerPage");
    }
  });
});

describe("analytics settings", () => {
  it("a GA4 measurement ID (stored in capitals) and a Plausible domain, both optional", () => {
    expect(analyticsSettingsSchema.parse({ ga4MeasurementId: " g-abc123xyz9 ", plausibleDomain: " Example.COM " })).toEqual({ ga4MeasurementId: "G-ABC123XYZ9", plausibleDomain: "example.com" });
    expect(analyticsSettingsSchema.parse({ ga4MeasurementId: "", plausibleDomain: "" })).toEqual({ ga4MeasurementId: undefined, plausibleDomain: undefined });
  });

  it("refuse anything that is not one: other ID kinds, script, URLs instead of domains", () => {
    for (const ga4MeasurementId of ["UA-12345-1", "G-", "G-12", "GTM-ABC123", "G-ABC123');alert(1);//", "<script>", "G-ABC 123"]) {
      expect(errorsOf(analyticsSettingsSchema, { ga4MeasurementId }), ga4MeasurementId).toEqual({ ga4MeasurementId: "Use a GA4 measurement ID like G-ABC123XYZ9." });
    }
    for (const plausibleDomain of ["https://example.com", "example", "example.com/path", "exa mple.com", "-example.com", 'example.com" onload="x', "localhost"]) {
      expect(errorsOf(analyticsSettingsSchema, { plausibleDomain }), plausibleDomain).toHaveProperty("plausibleDomain");
    }
  });
});

describe("what is stored, read for a page", () => {
  it("nothing stored: the plan's defaults (blog, 10), no tagline, no links, no analytics", () => {
    expect(readGeneral({})).toEqual({ tagline: "", social: {} });
    expect(readReading({})).toEqual({ blogPath: DEFAULT_BLOG_PATH, postsPerPage: DEFAULT_POSTS_PER_PAGE });
    expect(readAnalytics({})).toEqual({});
    for (const garbage of [null, "x", 42, []]) {
      expect(readGeneral(garbage)).toEqual({ tagline: "", social: {} });
      expect(readReading(garbage)).toEqual({ blogPath: "blog", postsPerPage: 10 });
      expect(readAnalytics(garbage)).toEqual({});
    }
  });

  it("each damaged value falls back alone", () => {
    expect(readGeneral({ tagline: 7, social: { instagram: "https://instagram.com/a", x: "javascript:alert(1)", other: "https://e.com" } })).toEqual({
      tagline: "", social: { instagram: "https://instagram.com/a" },
    });
    expect(readReading({ blogPath: "News Room", postsPerPage: 25 })).toEqual({ blogPath: "blog", postsPerPage: 25 });
    expect(readAnalytics({ ga4MeasurementId: "UA-1", plausibleDomain: "example.com" })).toEqual({ plausibleDomain: "example.com" });
  });

  it("social links in the networks' order, for the theme", () => {
    expect(socialLinks({ x: "https://x.com/a", facebook: "https://facebook.com/a" })).toEqual([
      { network: "facebook", label: "Facebook", href: "https://facebook.com/a" },
      { network: "x", label: "X", href: "https://x.com/a" },
    ]);
    expect(SOCIAL_KEYS).toEqual(["facebook", "instagram", "x", "linkedin", "youtube", "tiktok"]);
  });
});
