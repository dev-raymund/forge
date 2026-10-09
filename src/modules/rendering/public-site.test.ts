import { describe, expect, it } from "vitest";
import { htmlLang, renderableSite } from "./public-site";
import type { PublicSite } from "./queries";

/** What reaches a theme, and the page's language (M4-3). */

const site: PublicSite = {
  id: "0199a000-0000-7000-8000-000000000001",
  name: "Acme <Bakery>",
  tagline: "Bread & more",
  status: "coming_soon",
  language: "fil",
  timezone: "Asia/Manila",
  themeKey: "journal",
  themeSettings: { tokens: { colors: { primary: "#123456" } } },
};

describe("the public context", () => {
  it("is the site's public words, its base path, its theme and settings: no id, status or anything of anyone", () => {
    const renderable = renderableSite(site, { kind: "address", address: "acme" });
    expect(renderable).toEqual({
      name: "Acme <Bakery>", tagline: "Bread & more", language: "fil", basePath: "/s/acme", themeKey: "journal",
      themeSettings: { tokens: { colors: { primary: "#123456" } } },
    });
    expect(JSON.stringify(renderable)).not.toContain(site.id);
  });

  it("links are built from how the site was reached: /s/{address} in V1, its own host later", () => {
    expect(renderableSite(site, { kind: "address", address: "acme-2" }).basePath).toBe("/s/acme-2");
    expect(renderableSite(site, { kind: "host", hostname: "acme.example" }).basePath).toBe("");
  });
});

describe("the page's language", () => {
  it("is the site's, when it has the shape of a language tag; English otherwise", () => {
    for (const language of ["en", "fil", "pt-BR", "zh-Hant"]) expect(htmlLang({ language }), language).toBe(language);
    for (const language of ["", "e", "<script>", 'en" onload="x', "english language"]) expect(htmlLang({ language }), language).toBe("en");
    expect(htmlLang(null)).toBe("en");
  });
});
