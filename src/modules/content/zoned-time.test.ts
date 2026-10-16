import { describe, expect, it } from "vitest";
import { formatInZone, isTimeZone, offsetLabel, toLocalInput, zonedToUtc } from "./zoned-time";

/** Wall-clock times in a site's zone ↔ instants (M7-2): exact, and never a guess around a clock change. */

describe("zonedToUtc", () => {
  it.each([
    ["2026-10-20T09:30", "Asia/Manila", "2026-10-20T01:30:00.000Z"],
    ["2026-10-20T09:30", "UTC", "2026-10-20T09:30:00.000Z"],
    ["2026-01-15T00:00", "America/New_York", "2026-01-15T05:00:00.000Z"], // EST, UTC−5
    ["2026-07-15T00:00", "America/New_York", "2026-07-15T04:00:00.000Z"], // EDT, UTC−4
    ["2026-07-15T12:00", "Asia/Kolkata", "2026-07-15T06:30:00.000Z"], // UTC+5:30
    ["2026-12-31T23:59", "Pacific/Kiritimati", "2026-12-31T09:59:00.000Z"], // UTC+14
  ])("%s in %s is %s", (local, zone, iso) => {
    expect(zonedToUtc(local, zone)).toEqual({ ok: true, at: new Date(iso) });
  });

  it("refuses a time the clocks jump over, and one they go back over: never a guess", () => {
    expect(zonedToUtc("2026-03-08T02:30", "America/New_York")).toEqual({ ok: false, reason: "nonexistent" });
    expect(zonedToUtc("2026-11-01T01:30", "America/New_York")).toEqual({ ok: false, reason: "ambiguous" });
    expect(zonedToUtc("2026-03-29T01:30", "Europe/London")).toEqual({ ok: false, reason: "nonexistent" });
    expect(zonedToUtc("2026-10-25T01:30", "Europe/London")).toEqual({ ok: false, reason: "ambiguous" });
    // The minutes either side are fine.
    expect(zonedToUtc("2026-11-01T00:59", "America/New_York")).toMatchObject({ ok: true });
    expect(zonedToUtc("2026-11-01T02:00", "America/New_York")).toEqual({ ok: true, at: new Date("2026-11-01T07:00:00.000Z") });
  });

  it("refuses what is not a wall-clock time: other shapes, impossible dates, unknown zones, seconds, offsets", () => {
    for (const value of ["", "2026-10-20", "2026-10-20 09:30", "2026-10-20T9:30", "2026-02-30T10:00", "2026-13-01T10:00", "2026-10-20T24:00", "2026-10-20T09:30:00", "2026-10-20T09:30Z", "2026-10-20T09:30+08:00", 1760000000, null, "1969-12-31T23:00"]) {
      expect(zonedToUtc(value, "Asia/Manila"), String(value)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(zonedToUtc("2026-10-20T09:30", "Mars/Olympus")).toEqual({ ok: false, reason: "malformed" });
    expect(isTimeZone("Asia/Manila")).toBe(true);
    expect(isTimeZone("Asia/Nowhere")).toBe(false);
  });
});

describe("shown back in the zone", () => {
  it("as a datetime-local value, the same wall-clock time it was typed as", () => {
    expect(toLocalInput(new Date("2026-10-20T01:30:00.000Z"), "Asia/Manila")).toBe("2026-10-20T09:30");
    for (const [local, zone] of [["2026-07-15T00:00", "America/New_York"], ["2026-01-15T23:45", "Asia/Kolkata"]] as const) {
      const result = zonedToUtc(local, zone);
      expect(result.ok && toLocalInput(result.at, zone)).toBe(local);
    }
  });

  it("with its zone and offset named", () => {
    expect(offsetLabel(new Date("2026-10-20T01:30:00Z"), "Asia/Manila")).toBe("UTC+08:00");
    expect(offsetLabel(new Date("2026-01-15T05:00:00Z"), "America/New_York")).toBe("UTC−05:00");
    expect(offsetLabel(new Date("2026-07-15T06:30:00Z"), "Asia/Kolkata")).toBe("UTC+05:30");
    expect(offsetLabel(new Date("2026-07-15T06:30:00Z"), "UTC")).toBe("UTC");
    expect(formatInZone(new Date("2026-10-20T01:30:00Z"), "Asia/Manila")).toBe("Tue, 20 Oct 2026, 09:30 (Asia/Manila, UTC+08:00)");
  });
});
