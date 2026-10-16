import { describe, expect, it } from "vitest";
import { countOf, formatBytes, hasRoomFor, limitMessage, PLANS, type Allowance } from "./plans";

const GB = 1024 ** 3;

describe("the plans' limits (plan §14)", () => {
  it("Free: 1 site and 1 GiB (1,073,741,824 bytes), 20 manual revisions kept per entry. Pro, and the Pro trial: 5 sites, 20 GiB, 100", () => {
    expect(PLANS.free).toEqual({ label: "Free", limits: { sites: 1, storage: GB }, manualRevisions: 20 });
    expect(GB).toBe(1_073_741_824);
    expect(PLANS.pro).toEqual({ label: "Pro", limits: { sites: 5, storage: 20 * GB }, manualRevisions: 100 });
    expect(Object.isFrozen(PLANS)).toBe(true);
  });

  it("there is room while fewer are used than allowed, and not once the limit is reached or passed (after a downgrade)", () => {
    const allowance = (used: number, plan: Allowance["plan"] = "pro"): Allowance => ({ plan, key: "sites", used, limit: PLANS[plan].limits.sites });
    expect([0, 1, 4].map((used) => hasRoomFor(allowance(used)))).toEqual([true, true, true]);
    expect([5, 6].map((used) => hasRoomFor(allowance(used)))).toEqual([false, false]);
    expect([hasRoomFor(allowance(0, "free")), hasRoomFor(allowance(1, "free")), hasRoomFor(allowance(3, "free"))]).toEqual([true, false, false]);
  });

  it("storage: room for these bytes only if they fit, up to the last byte", () => {
    const allowance = (used: number): Allowance => ({ plan: "free", key: "storage", used, limit: GB });
    expect(hasRoomFor(allowance(0), GB)).toBe(true);
    expect(hasRoomFor(allowance(GB - 10), 10)).toBe(true);
    expect(hasRoomFor(allowance(GB - 10), 11)).toBe(false);
    expect(hasRoomFor(allowance(GB + 1), 1)).toBe(false); // over it after a downgrade: nothing more
  });

  it("says which plan and how many, in words", () => {
    expect(countOf("sites", 1)).toBe("1 site");
    expect(countOf("sites", 5)).toBe("5 sites");
    expect(countOf("storage", 20 * GB)).toBe("20 GiB of storage");
    expect(limitMessage({ plan: "free", key: "sites", used: 1, limit: 1 })).toBe("The Free plan includes 1 site, and this organization has reached it.");
    expect(limitMessage({ plan: "pro", key: "sites", used: 5, limit: 5 })).toBe("The Pro plan includes 5 sites, and this organization has reached it.");
    expect(limitMessage({ plan: "free", key: "storage", used: 900 * 1024 ** 2, limit: GB })).toBe(
      "The Free plan includes 1 GiB of storage, and these files would take this organization past it (900 MiB used).",
    );
  });

  it("formats bytes in binary units, as they are counted (M6-3)", () => {
    expect([0, 1, 1023].map(formatBytes)).toEqual(["0 bytes", "1 byte", "1023 bytes"]);
    expect([1024, 1536, 20 * 1024 ** 2, 1.5 * GB, GB].map(formatBytes)).toEqual(["1 KiB", "1.5 KiB", "20 MiB", "1.5 GiB", "1 GiB"]);
  });
});
