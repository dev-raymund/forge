import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLogSink } from "@/platform/observability/logger";
import { betterAuthLog } from "./log";

const lines: { level: string; entry: Record<string, unknown> }[] = [];
beforeEach(() => {
  lines.length = 0;
  setLogSink((level, line) => lines.push({ level, entry: JSON.parse(line) }));
});
afterEach(() => setLogSink(null));

describe("betterAuthLog", () => {
  it("writes Better Auth's lines as Forge JSON logs at the same level", () => {
    betterAuthLog("warn", "Invalid password");
    expect(lines).toEqual([{ level: "warn", entry: expect.objectContaining({ level: "warn", msg: "better-auth: Invalid password", module: "auth" }) }]);
  });

  it("removes email addresses from messages", () => {
    betterAuthLog("info", "Sign-up attempt for existing email: ada@example.test");
    expect(lines[0]!.entry.msg).toBe("better-auth: Sign-up attempt for existing email: [email]");
    expect(JSON.stringify(lines)).not.toContain("ada@example.test");
  });

  it("keeps extra strings, redacts sensitive keys in objects, and serialises errors", () => {
    betterAuthLog("error", "Failed to create user", "for bob@example.test", { provider: "google", token: "abc123" }, new Error("boom"));
    const { entry } = lines[0]!;
    expect(entry.msg).toBe("better-auth: Failed to create user for [email]");
    expect(entry.detail).toEqual([{ provider: "google", token: "[redacted]" }]);
    expect(entry.err).toMatchObject({ name: "Error", message: "boom" });
    expect(JSON.stringify(entry)).not.toContain("abc123");
  });
});
