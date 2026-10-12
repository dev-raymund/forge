import { describe, expect, it } from "vitest";
import { HTTP_STATUS, isShowable, renderStateFor, robotsFor, type RenderStateKind } from "./render-state";

/**
 * What a public request renders, from the site's status (M4-3, ADR 0013). A live site's path is resolved next
 * (M5-6, ./routes.ts and ./content.ts); one that names nothing is `page-not-found`.
 */

describe("the render state", () => {
  it("no site at the address: the platform's not found", () => {
    expect(renderStateFor(null)).toEqual({ kind: "site-not-found" });
  });

  it("a suspended site, or any status the renderer does not know: unavailable", () => {
    for (const status of ["suspended", "archived", "maintenance", "", "LIVE", "live "]) expect(renderStateFor({ status }), status).toEqual({ kind: "site-unavailable" });
  });

  it("coming soon: the coming-soon page, whatever the path, so nothing unpublished shows", () => {
    expect(renderStateFor({ status: "coming_soon" })).toEqual({ kind: "coming-soon" });
  });

  it("live: its paths are looked up", () => {
    expect(renderStateFor({ status: "live" })).toEqual({ kind: "live" });
  });

  it("only coming-soon and live sites are shown, and drawn by their theme", () => {
    expect([null, { status: "suspended" }, { status: "x" }].map(isShowable)).toEqual([false, false, false]);
    expect([{ status: "coming_soon" }, { status: "live" }].map(isShowable)).toEqual([true, true]);
  });
});

describe("what each state answers", () => {
  const kinds: RenderStateKind[] = ["site-not-found", "site-unavailable", "coming-soon", "live", "page-not-found"];

  it("a real 404 for every page that is not there, or not shown; 200 for the rest", () => {
    expect(Object.fromEntries(kinds.map((kind) => [kind, HTTP_STATUS[kind]]))).toEqual({
      "site-not-found": 404, "site-unavailable": 404, "coming-soon": 200, live: 200, "page-not-found": 404,
    });
  });

  it("only a live site's page may be indexed: coming soon, unavailable and missing pages are noindex, nofollow", () => {
    expect(robotsFor("live")).toEqual({ index: true, follow: true });
    for (const kind of kinds.filter((k) => k !== "live")) expect(robotsFor(kind), kind).toEqual({ index: false, follow: false });
  });
});
