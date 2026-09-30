import { describe, expect, it } from "vitest";
import { z } from "zod";
import { backoffSeconds, createJobRegistry, defineJob, DEFAULT_BACKOFF } from "./definition";

const job = (type: string) => defineJob({ type, scope: "platform", payload: z.object({}), run: async () => {} });

describe("defineJob / createJobRegistry", () => {
  it("requires module.action type names", () => {
    expect(() => job("email.send")).not.toThrow();
    expect(() => job("jobs.cleanup")).not.toThrow();
    expect(() => job("send")).toThrow();
    expect(() => job("Email.Send")).toThrow();
  });

  it("rejects a type registered twice and lists the registered types", () => {
    expect(() => createJobRegistry([job("a.b"), job("a.b")])).toThrow(/registered twice/);
    const registry = createJobRegistry([job("a.b"), job("c.d")]);
    expect(registry.types).toEqual(["a.b", "c.d"]);
    expect(registry.get("c.d")?.type).toBe("c.d");
    expect(registry.get("x.y")).toBeUndefined();
  });
});

describe("backoffSeconds", () => {
  it("doubles per attempt, stays within [half, full] of the exponential step, and caps", () => {
    const low = (n: number) => backoffSeconds(n, DEFAULT_BACKOFF, () => 0);
    const high = (n: number) => backoffSeconds(n, DEFAULT_BACKOFF, () => 1);
    expect([low(1), high(1)]).toEqual([15, 30]);
    expect([low(2), high(2)]).toEqual([30, 60]);
    expect([low(3), high(3)]).toEqual([60, 120]);
    expect(high(20)).toBe(3_600); // capped at 1 h
    expect(low(20)).toBe(1_800);
  });

  it("never returns zero, so retries never hammer a failing provider", () => {
    for (let n = 1; n < 10; n++) expect(backoffSeconds(n, DEFAULT_BACKOFF, () => 0)).toBeGreaterThan(0);
  });
});
