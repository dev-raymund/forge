import { describe, expect, it } from "vitest";
import { hasBearerSecret } from "./bearer";

describe("hasBearerSecret", () => {
  const secret = "s".repeat(32);
  it("accepts only the exact bearer secret", () => {
    expect(hasBearerSecret(new Headers({ authorization: `Bearer ${secret}` }), secret)).toBe(true);
    expect(hasBearerSecret(new Headers({ authorization: `Bearer ${secret}x` }), secret)).toBe(false);
    expect(hasBearerSecret(new Headers({ authorization: secret }), secret)).toBe(false);
    expect(hasBearerSecret(new Headers(), secret)).toBe(false);
  });
  it("never matches when no secret is configured", () => {
    expect(hasBearerSecret(new Headers({ authorization: "Bearer " }), "")).toBe(false);
  });
});
