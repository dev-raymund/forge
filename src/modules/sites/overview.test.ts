import { describe, expect, it } from "vitest";
import { onboardingNext } from "./onboarding";
import { launchChecklist, STATUS_EXPLANATIONS } from "./overview";

const paths = { settings: "/acme/sites/bakery/settings", publicSite: "/s/acme-bakery" };
const facts = { publishedPages: 0, menusWithItems: 0, seoConfigured: false, hasAddress: true, status: "coming_soon" };

describe("the launch checklist (M4-2)", () => {
  it("the plan's five items, in order; each done only from what the database holds", () => {
    const items = launchChecklist(facts, paths);
    expect(items.map((item) => item.key)).toEqual(["pages", "menu", "seo", "domain", "publish"]);
    expect(items.map((item) => item.done)).toEqual([false, false, false, true, false]);
    const done = launchChecklist({ publishedPages: 3, menusWithItems: 1, seoConfigured: true, hasAddress: true, status: "live" }, paths);
    expect(done.every((item) => item.done)).toBe(true);
    expect(done[0]!.note).toBe("3 published pages.");
  });

  it("links only to screens that exist (the address, in settings); the rest say they are not available yet", () => {
    const items = launchChecklist(facts, paths);
    expect(items.filter((item) => item.href).map((item) => [item.key, item.href])).toEqual([["domain", paths.settings]]);
    for (const key of ["pages", "menu", "seo", "publish"]) expect(items.find((item) => item.key === key)!.note).toBe("Not available yet.");
    expect(items.find((item) => item.key === "domain")!.note).toBe("Visitors find it at /s/acme-bakery.");
  });

  it("a status is explained to the site's people, and a suspension's reason is never part of it", () => {
    expect(Object.keys(STATUS_EXPLANATIONS).sort()).toEqual(["coming_soon", "live", "suspended"]);
    expect(STATUS_EXPLANATIONS.suspended).toBe("The site is unavailable to visitors.");
    expect(launchChecklist({ ...facts, status: "suspended" }, paths).at(-1)!.note).toBe("The site is unavailable.");
  });
});

describe("where onboarding resumes (M4-2)", () => {
  it("no organization: step 1; one without a site that the member may fill: step 2; otherwise done", () => {
    expect(onboardingNext({ home: null, sitesInHome: 0, canCreateSites: true })).toEqual({ step: "organization" });
    expect(onboardingNext({ home: { slug: "acme" }, sitesInHome: 0, canCreateSites: true })).toEqual({ step: "site", orgSlug: "acme" });
    expect(onboardingNext({ home: { slug: "acme" }, sitesInHome: 1, canCreateSites: true })).toEqual({ step: "done", orgSlug: "acme" });
    expect(onboardingNext({ home: { slug: "acme" }, sitesInHome: 0, canCreateSites: false })).toEqual({ step: "done", orgSlug: "acme" });
  });
});
