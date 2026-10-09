import { describe, expect, it } from "vitest";
import { HTTP_STATUS, isShowable, renderStateFor, robotsFor, type RenderStateKind } from "./render-state";

/** What a public request renders, from the site's status and the path (M4-3, ADR 0013). */

describe("the render state", () => {
  it("no site at the address: the platform's not found, at every path", () => {
    for (const path of [[], ["about"], ["blog", "post"]]) expect(renderStateFor(null, path)).toEqual({ kind: "site-not-found" });
  });

  it("a suspended site, or any status the renderer does not know: unavailable, at every path", () => {
    for (const status of ["suspended", "archived", "maintenance", "", "LIVE", "live "]) {
      for (const path of [[], ["about"]]) expect(renderStateFor({ status }, path), `${status} ${path}`).toEqual({ kind: "site-unavailable" });
    }
  });

  it("coming soon: the coming-soon page at every path, so nothing unpublished shows", () => {
    for (const path of [[], ["about"], ["blog", "example"], ["contact"]]) expect(renderStateFor({ status: "coming_soon" }, path)).toEqual({ kind: "coming-soon" });
  });

  it("live: the home page, and not found for every other path until content exists (M5-6)", () => {
    expect(renderStateFor({ status: "live" }, [])).toEqual({ kind: "home" });
    expect(renderStateFor({ status: "live" })).toEqual({ kind: "home" });
    for (const path of [["about"], ["contact"], ["blog", "example"], ["index"]]) expect(renderStateFor({ status: "live" }, path)).toEqual({ kind: "page-not-found" });
  });

  it("only coming-soon and live sites are shown, and drawn by their theme", () => {
    expect([null, { status: "suspended" }, { status: "x" }].map(isShowable)).toEqual([false, false, false]);
    expect([{ status: "coming_soon" }, { status: "live" }].map(isShowable)).toEqual([true, true]);
  });
});

describe("what each state answers", () => {
  const kinds: RenderStateKind[] = ["site-not-found", "site-unavailable", "coming-soon", "home", "page-not-found"];

  it("a real 404 for every page that is not there, or not shown; 200 for the rest", () => {
    expect(Object.fromEntries(kinds.map((kind) => [kind, HTTP_STATUS[kind]]))).toEqual({
      "site-not-found": 404, "site-unavailable": 404, "coming-soon": 200, home: 200, "page-not-found": 404,
    });
  });

  it("only a live site's page may be indexed: coming soon, unavailable and missing pages are noindex, nofollow", () => {
    expect(robotsFor("home")).toEqual({ index: true, follow: true });
    for (const kind of kinds.filter((k) => k !== "home")) expect(robotsFor(kind), kind).toEqual({ index: false, follow: false });
  });
});
