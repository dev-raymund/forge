import { describe, expect, it } from "vitest";
import { isUniqueViolation, pgErrorOf } from "./errors";

const driver = (code: string, constraint?: string) => Object.assign(new Error("duplicate key value"), { code, constraint });
/** What Drizzle throws: its own error with the driver's in `.cause`. */
const wrapped = (cause: unknown) => Object.assign(new Error("Failed query: insert into …"), { cause });

describe("pgErrorOf / isUniqueViolation", () => {
  it("finds the Postgres error under Drizzle's wrapper", () => {
    expect(pgErrorOf(wrapped(driver("23505", "organizations_slug_unique")))).toEqual({ code: "23505", constraint: "organizations_slug_unique" });
    expect(pgErrorOf(driver("23503"))).toEqual({ code: "23503", constraint: undefined });
  });

  it("recognises a unique violation, optionally of one constraint", () => {
    const error = wrapped(driver("23505", "organizations_slug_unique"));
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, "organizations_slug_unique")).toBe(true);
    expect(isUniqueViolation(error, "users_email_unique")).toBe(false);
    expect(isUniqueViolation(wrapped(driver("23503", "x")))).toBe(false);
  });

  it("is not fooled by other errors and codes", () => {
    for (const value of [null, undefined, "23505", new Error("boom"), { code: 23505 }, { code: "ECONNRESET" }, wrapped(new Error("x"))]) {
      expect(isUniqueViolation(value)).toBe(false);
    }
    expect(pgErrorOf(new Error("boom"))).toBeNull();
  });
});
