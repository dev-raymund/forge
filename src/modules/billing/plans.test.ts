import { describe, expect, it } from "vitest";
import { countOf, hasRoomFor, limitMessage, PLANS, type Allowance } from "./plans";

describe("the plans' site limits (plan §14)", () => {
  it("Free: 1 site. Pro, and the Pro trial: 5", () => {
    expect(PLANS.free).toEqual({ label: "Free", limits: { sites: 1 } });
    expect(PLANS.pro).toEqual({ label: "Pro", limits: { sites: 5 } });
    expect(Object.isFrozen(PLANS)).toBe(true);
  });

  it("there is room while fewer are used than allowed, and not once the limit is reached or passed (after a downgrade)", () => {
    const allowance = (used: number, plan: Allowance["plan"] = "pro"): Allowance => ({ plan, key: "sites", used, limit: PLANS[plan].limits.sites });
    expect([0, 1, 4].map((used) => hasRoomFor(allowance(used)))).toEqual([true, true, true]);
    expect([5, 6].map((used) => hasRoomFor(allowance(used)))).toEqual([false, false]);
    expect([hasRoomFor(allowance(0, "free")), hasRoomFor(allowance(1, "free")), hasRoomFor(allowance(3, "free"))]).toEqual([true, false, false]);
  });

  it("says which plan and how many, in words", () => {
    expect(countOf("sites", 1)).toBe("1 site");
    expect(countOf("sites", 5)).toBe("5 sites");
    expect(limitMessage({ plan: "free", key: "sites", used: 1, limit: 1 })).toBe("The Free plan includes 1 site, and this organization has reached it.");
    expect(limitMessage({ plan: "pro", key: "sites", used: 5, limit: 5 })).toBe("The Pro plan includes 5 sites, and this organization has reached it.");
  });
});
