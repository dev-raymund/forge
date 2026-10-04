import { describe, expect, it } from "vitest";
import { checkOrgSlug, isReservedOrgSlug, looksLikeOrgSlug, ORG_SLUG_MAX, RESERVED_ORG_SLUGS, suggestOrgSlug } from "./slugs";
import { createOrganizationSchema, updateOrganizationSchema } from "./validation";

describe("checkOrgSlug", () => {
  it.each([["acme"], ["acme-studio"], ["a1b"], ["studio-42"], ["abc"], ["x".repeat(ORG_SLUG_MAX)]])("accepts %s", (slug) =>
    expect(checkOrgSlug(slug)).toEqual({ ok: true, slug }),
  );

  it("has one spelling: trimmed and lowercased", () => {
    expect(checkOrgSlug("  Acme-Studio ")).toEqual({ ok: true, slug: "acme-studio" });
    expect(checkOrgSlug("ACME")).toEqual({ ok: true, slug: "acme" });
  });

  it.each([
    ["", "Enter a URL for the organization."],
    ["   ", "Enter a URL for the organization."],
    ["ab", "Use at least 3 characters."],
    ["x".repeat(ORG_SLUG_MAX + 1), "Use at most 63 characters."],
    ["acme studio", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
    ["acme_studio", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
    ["acme--studio", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
    ["-acme", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
    ["acme-", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
    ["acme.co", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
    ["acme/sites", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
    ["../acme", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
    ["acmé", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
    ["%61cme", "Use lowercase letters, numbers and single hyphens, e.g. acme-studio."],
  ])("rejects %j", (slug, message) => expect(checkOrgSlug(slug)).toEqual({ ok: false, message }));

  it.each(["login", "signup", "onboarding", "account", "invite", "platform", "api", "verify-email", "forgot-password", "reset-password",
    "settings", "new", "media", "dev", "render"])("%s is reserved: it is a path of the app", (slug) => {
    expect(isReservedOrgSlug(slug)).toBe(true);
    expect(checkOrgSlug(slug)).toEqual({ ok: false, message: "That URL is reserved. Choose another." });
    expect(checkOrgSlug(slug.toUpperCase())).toMatchObject({ ok: false });
  });

  it("reserved words only block the whole slug", () => {
    expect(checkOrgSlug("login-studio")).toMatchObject({ ok: true });
    expect(checkOrgSlug("my-api")).toMatchObject({ ok: true });
  });

  it("the single-letter and underscore prefixes cannot be slugs at all", () => {
    for (const slug of ["s", "_next", "_forge"]) {
      expect(RESERVED_ORG_SLUGS.has(slug)).toBe(true);
      expect(checkOrgSlug(slug).ok).toBe(false);
    }
  });
});

describe("looksLikeOrgSlug (what the resolver will ask the database about)", () => {
  it.each([["acme", true], ["a", true], ["login", true], ["Acme", false], ["acme/x", false], ["acme'--", false], ["", false], [" acme", false],
    ["x".repeat(64), false], ["acme\u0000", false]])("%j → %s", (value, expected) => expect(looksLikeOrgSlug(value)).toBe(expected));
});

describe("suggestOrgSlug", () => {
  it.each([
    ["Acme Studio", "acme-studio"],
    ["Acme Studio, Inc.", "acme-studio-inc"],
    ["  Café  Zürich  ", "cafe-zurich"],
    ["R&D Lab", "r-and-d-lab"],
    ["---", ""],
    ["日本語", ""],
    ["A", "a"],
  ])("%j → %j", (name, slug) => expect(suggestOrgSlug(name)).toBe(slug));

  it("never exceeds the maximum or ends in a hyphen; it is a suggestion, not a verdict", () => {
    const long = suggestOrgSlug(`${"word ".repeat(30)}`);
    expect(long.length).toBeLessThanOrEqual(ORG_SLUG_MAX);
    expect(long.endsWith("-")).toBe(false);
    expect(checkOrgSlug(suggestOrgSlug("A")).ok).toBe(false); // too short: the user is asked
    expect(checkOrgSlug(suggestOrgSlug("Login")).ok).toBe(false); // reserved: the user is asked
  });
});

describe("organization schemas", () => {
  it("create: a name and a slug, both normalised", () => {
    expect(createOrganizationSchema.parse({ name: "  Acme Studio ", slug: " Acme-Studio " })).toEqual({ name: "Acme Studio", slug: "acme-studio" });
  });

  it("create: says what is wrong with each field", () => {
    const result = createOrganizationSchema.safeParse({ name: " ", slug: "login" });
    expect(result.success).toBe(false);
    const issues = Object.fromEntries(result.error!.issues.map((issue) => [issue.path.join("."), issue.message]));
    expect(issues).toEqual({ name: "Enter a name for the organization.", slug: "That URL is reserved. Choose another." });
    expect(createOrganizationSchema.safeParse({ name: "x".repeat(81), slug: "acme" }).success).toBe(false);
    expect(createOrganizationSchema.safeParse({ name: "Acme" }).success).toBe(false);
  });

  it("create: nothing else is a field (an id, an owner or a status from the caller is dropped)", () => {
    const parsed = createOrganizationSchema.parse({ name: "Acme", slug: "acme", id: "x", ownerId: "y", status: "suspended", organizationId: "z" });
    expect(parsed).toEqual({ name: "Acme", slug: "acme" });
  });

  it("update: either field, at least one", () => {
    expect(updateOrganizationSchema.parse({ name: "New Name" })).toEqual({ name: "New Name" });
    expect(updateOrganizationSchema.parse({ slug: "New-Slug" })).toEqual({ slug: "new-slug" });
    expect(updateOrganizationSchema.safeParse({}).success).toBe(false);
    expect(updateOrganizationSchema.safeParse({ slug: "settings" }).success).toBe(false);
  });
});
