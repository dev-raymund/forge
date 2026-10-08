import { describe, expect, it } from "vitest";
import { currentHref } from "./section-nav";

describe("which link of a section's nav is the open page", () => {
  const org = ["/acme/sites", "/acme/members", "/acme/activity", "/acme/settings"];
  const site = ["/acme/sites/shop", "/acme/sites/shop/settings"];

  it("the page's own link", () => {
    expect(currentHref("/acme/members", org)).toBe("/acme/members");
    expect(currentHref("/acme/settings", org)).toBe("/acme/settings");
  });

  it("Sites stays open on every page of the sites area", () => {
    for (const page of ["/acme/sites/new", "/acme/sites/shop", "/acme/sites/shop/settings"]) expect(currentHref(page, org), page).toBe("/acme/sites");
  });

  it("the longest match wins: the site's Settings, not its Overview", () => {
    expect(currentHref("/acme/sites/shop/settings", site)).toBe("/acme/sites/shop/settings");
    expect(currentHref("/acme/sites/shop", site)).toBe("/acme/sites/shop");
  });

  it("a prefix of a word is not a match", () => {
    expect(currentHref("/acme/sitesmore", org)).toBeUndefined();
    expect(currentHref("/acme/settings-old", org)).toBeUndefined();
    expect(currentHref("/elsewhere", org)).toBeUndefined();
  });
});
