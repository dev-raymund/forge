import { describe, expect, it } from "vitest";
import { ACTIVITY_PAGE_SIZE, activityHref, dayRange, decodeCursor, encodeCursor, hasFilters, parseActivityQuery } from "./activity-query";

const MEMBER = "0199a000-0000-7000-8000-0000000000a1";
const SITE = "0199a000-0000-7000-8000-0000000000b2";
const CURSOR = `1767225600123456_${MEMBER}`;

describe("the activity page's URL", () => {
  it("reads the filters it knows, in one spelling", () => {
    expect(parseActivityQuery({ action: "member.invited", member: MEMBER.toUpperCase(), site: SITE, from: "2026-01-10", to: "2026-01-31", before: CURSOR })).toEqual({
      action: "member.invited", member: MEMBER, site: SITE, from: "2026-01-10", to: "2026-01-31", before: CURSOR,
    });
    expect(parseActivityQuery({})).toEqual({});
  });

  it("drops what is not a filter value, one by one, and keeps the rest", () => {
    const junk: Record<string, (string | string[] | undefined)[]> = {
      action: ["", "entry.published", "member", "MEMBER.INVITED", "toString", "' or 1=1 --", "member.invited "],
      member: ["", "me", "not-a-uuid", `${MEMBER}x`, "' or 1=1 --", "../../etc/passwd"],
      site: ["", "all", "not-a-uuid"],
      from: ["", "yesterday", "2026-13-01", "2026-02-30", "2026-1-1", "01/02/2026", "2026-01-10T00:00:00Z", "' or 1=1 --"],
      to: ["", "tomorrow", "2026-00-10", "2026-04-31"],
      before: ["", "garbage", "1_2", `${"9".repeat(30)}_${MEMBER}`, `1767225600123456_${MEMBER}x`, `abc_${MEMBER}`, "' or 1=1 --"],
    };
    for (const [key, values] of Object.entries(junk)) {
      for (const value of values) {
        expect(parseActivityQuery({ [key]: value, action: key === "action" ? value : "member.left" }), `${key}=${String(value)}`).toEqual(key === "action" ? {} : { action: "member.left" });
      }
    }
  });

  it("a repeated parameter counts once, and parameters it does not know are not filters", () => {
    expect(parseActivityQuery({ action: ["member.left", "member.invited"], from: ["2026-01-10", "2026-01-11"] })).toEqual({ action: "member.left", from: "2026-01-10" });
    expect(parseActivityQuery({ organizationId: MEMBER, org: "other-org", orgSlug: "other-org", userId: MEMBER, limit: "100000", sort: "ip", order: "asc" })).toEqual({});
  });

  it("days are whole UTC days, both ends included", () => {
    expect(dayRange({ from: "2026-01-10", to: "2026-01-10" })).toEqual({ from: new Date("2026-01-10T00:00:00.000Z"), before: new Date("2026-01-11T00:00:00.000Z") });
    expect(dayRange({ from: "2026-02-28" })).toEqual({ from: new Date("2026-02-28T00:00:00.000Z"), before: undefined });
    expect(dayRange({ to: "2028-02-28" }).before).toEqual(new Date("2028-02-29T00:00:00.000Z")); // a leap year
    expect(dayRange({})).toEqual({ from: undefined, before: undefined });
  });

  it("knows whether anything is being filtered: a page cursor alone is not a filter", () => {
    expect(hasFilters({})).toBe(false);
    expect(hasFilters({ before: CURSOR })).toBe(false);
    for (const query of [{ action: "member.left" as const }, { member: MEMBER }, { site: SITE }, { from: "2026-01-10" }, { to: "2026-01-10" }]) expect(hasFilters(query)).toBe(true);
  });

  it("links to another page keep the filters and are always this page's own path", () => {
    const base = "/acme/activity";
    expect(activityHref(base, {})).toBe(base);
    expect(activityHref(base, { action: "member.invited", member: MEMBER, from: "2026-01-10" }, { before: CURSOR })).toBe(
      `${base}?action=member.invited&member=${MEMBER}&from=2026-01-10&before=${CURSOR}`,
    );
    // Back to the newest: the same filters, without the cursor.
    expect(activityHref(base, { action: "member.left", before: CURSOR }, { before: undefined })).toBe(`${base}?action=member.left`);
    for (const href of [activityHref(base, { action: "member.left" }), activityHref(base, { before: CURSOR })]) expect(href.startsWith(`${base}?`)).toBe(true);
  });

  it("a page is a fixed size", () => {
    expect(ACTIVITY_PAGE_SIZE).toBe(25);
  });
});

describe("the page cursor", () => {
  it("is the last event's time in microseconds and its id, and reads back exactly", () => {
    const cursor = { micros: "1767225600123456", id: MEMBER };
    expect(encodeCursor(cursor)).toBe(CURSOR);
    expect(decodeCursor(CURSOR)).toEqual(cursor);
    // The digits are kept as text: a number would round the last ones away.
    expect(decodeCursor(`9007199254740993123_${MEMBER}`)?.micros).toBe("9007199254740993123");
    expect(encodeCursor({ micros: "1767225600123456", id: MEMBER })).toMatch(/^[0-9a-f_-]+$/); // safe in a URL as it is
  });

  it("anything else is not a cursor", () => {
    for (const value of ["", "x", "_", `_${MEMBER}`, "1767225600123456_", `1767225600123456_${MEMBER.toUpperCase()}`, `1767225600123456-${MEMBER}`, `-1_${MEMBER}`, `1.5_${MEMBER}`, `1e15_${MEMBER}`, `${CURSOR}_extra`, ` ${CURSOR}`, null, undefined, 7, {}, [CURSOR]]) {
      expect(decodeCursor(value), String(value)).toBeNull();
    }
  });
});
