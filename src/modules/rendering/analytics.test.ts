import { describe, expect, it } from "vitest";
import { tagsForAll } from "@/platform/cache";
import { ANALYTICS_SCRIPTS_ACTIVE, emitsAnalytics, safeAnalytics } from "./ui/analytics";

describe("what analytics a page may carry (M4-2, ADR 0006 §5)", () => {
  it("only a GA4 measurement ID and a Plausible domain that pass their rules, checked again here", () => {
    expect(safeAnalytics({ ga4MeasurementId: "G-ABC1234567", plausibleDomain: "example.com" })).toEqual({ ga4: "G-ABC1234567", plausible: "example.com" });
    expect(safeAnalytics({})).toEqual({ ga4: null, plausible: null });
    for (const ga4MeasurementId of ["G-ABC1234567');alert(1);//", "g-abc1234567", "UA-1", "</script><script>alert(1)</script>"]) {
      expect(safeAnalytics({ ga4MeasurementId }).ga4, ga4MeasurementId).toBeNull();
    }
    for (const plausibleDomain of ['example.com" onload="x', "https://example.com", "example"]) expect(safeAnalytics({ plausibleDomain }).plausible, plausibleDomain).toBeNull();
  });

  it("no page runs analytics scripts, live or coming soon, until consent behaviour exists (M4-5, ADR 0015 §6)", () => {
    expect(ANALYTICS_SCRIPTS_ACTIVE).toBe(false);
    for (const status of ["live", "coming_soon", "suspended", ""]) expect(emitsAnalytics(status), status).toBe(false);
  });

  it("a settings change flushes the site's settings tag, and only that", () => {
    expect(tagsForAll([{ type: "site.configChanged", siteId: "s1" }])).toEqual({ immediate: ["site:s1:config"], stale: [] });
  });
});
