import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logger, redact, serializeError, setLogSink, withLogContext } from "./logger";

let lines: { level: string; line: Record<string, unknown> }[] = [];
beforeEach(() => {
  lines = [];
  setLogSink((level, line) => lines.push({ level, line: JSON.parse(line) }));
});
afterEach(() => {
  setLogSink(null);
  delete process.env.LOG_LEVEL;
});

describe("logger", () => {
  it("writes one JSON line with level, msg, time and fields", () => {
    logger.info("entry published", { durationMs: 12 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toMatchObject({ level: "info", msg: "entry published", durationMs: 12 });
    expect(Date.parse(lines[0]!.line.time as string)).not.toBeNaN();
  });

  it("carries request and tenant context through async work, for logging only", async () => {
    await withLogContext({ requestId: "req-12345678", orgId: "org-1" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      await withLogContext({ siteId: "site-1" }, async () => logger.child({ module: "content" }).info("saved"));
    });
    logger.info("outside");
    expect(lines[0]!.line).toMatchObject({ requestId: "req-12345678", orgId: "org-1", siteId: "site-1", module: "content" });
    expect(lines[1]!.line.requestId).toBeUndefined();
  });

  it("respects LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    logger.info("hidden");
    logger.warn("shown");
    expect(lines.map((l) => l.line.msg)).toEqual(["shown"]);
  });

  it("redacts secrets and emails", () => {
    logger.info("login for alice@example.com", { password: "hunter2", headers: { authorization: "Bearer x", cookie: "s=1" }, note: "cc bob@example.org" });
    const line = JSON.stringify(lines[0]!.line);
    expect(line).not.toMatch(/hunter2|Bearer x|s=1|bob@example\.org/);
    expect(lines[0]!.line.note).toBe("cc [email]");
  });

  it("serializes errors without driver details", () => {
    const pgError = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505", detail: "Key (email)=(alice@example.com) already exists.",
    });
    logger.error("failed", { err: pgError });
    const err = lines[0]!.line.err as Record<string, unknown>;
    expect(err).toMatchObject({ name: "Error", code: "23505" });
    expect(JSON.stringify(err)).not.toContain("alice@example.com");
    expect(serializeError(undefined)).toBeUndefined();
  });

  it("never throws, even on circular data", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.info("x", { circular })).not.toThrow();
    expect(redact({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } })).toBeDefined();
  });
});
