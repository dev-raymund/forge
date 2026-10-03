import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AppError, conflict, forbidden, limitExceeded, notFound, problemResponse, rateLimited, toActionResult, toProblem,
  unauthenticated, unavailable, validationError,
} from "./errors";

const RID = "01a0f2c0-0000-7000-8000-000000000001";

describe("toActionResult", () => {
  it("maps each AppError kind to { ok: false, code, error }", () => {
    for (const [err, code] of [
      [unauthenticated(), "Unauthenticated"], [notFound(), "NotFound"], [forbidden(), "Forbidden"], [conflict("Slug taken."), "Conflict"],
      [limitExceeded("sites"), "LimitExceeded"], [rateLimited(30), "RateLimited"], [unavailable(), "Unavailable"],
    ] as const) {
      expect(toActionResult(err, RID)).toEqual({ ok: false, code, error: err.message });
    }
  });

  it("carries field errors for validation, from AppError or a ZodError", () => {
    expect(toActionResult(validationError({ slug: ["Taken"] }))).toMatchObject({ code: "Validation", fieldErrors: { slug: ["Taken"] } });
    const zod = z.object({ name: z.string().min(2), nested: z.object({ n: z.number() }) }).safeParse({ name: "x", nested: { n: "1" } });
    const result = toActionResult(zod.error);
    expect(result).toMatchObject({ ok: false, code: "Validation" });
    expect(Object.keys((result as { fieldErrors: object }).fieldErrors)).toEqual(["name", "nested.n"]);
  });

  it("hides unexpected errors behind a generic message with the request ID", () => {
    const result = toActionResult(new Error("duplicate key value violates unique constraint (email)=(a@b.c)"), RID);
    expect(result).toEqual({ ok: false, code: "Internal", error: `Something went wrong. Reference: ${RID}`, requestId: RID });
  });

  it("never reveals whether a resource exists elsewhere", () => {
    expect(notFound().message).toBe("Not found.");
  });
});

describe("problem+json (RFC 9457)", () => {
  it.each([
    [unauthenticated(), 401, "urn:forge:problem:unauthenticated"],
    [notFound(), 404, "urn:forge:problem:not-found"],
    [forbidden(), 403, "urn:forge:problem:forbidden"],
    [validationError({ a: ["x"] }), 422, "urn:forge:problem:validation"],
    [conflict("x"), 409, "urn:forge:problem:conflict"],
    [limitExceeded("sites"), 402, "urn:forge:problem:limit-exceeded"],
    [rateLimited(), 429, "urn:forge:problem:rate-limited"],
    [unavailable(), 503, "urn:forge:problem:unavailable"],
    [new Error("boom"), 500, "urn:forge:problem:internal"],
  ])("%s → %i", (err, status, type) => {
    const p = toProblem(err, RID);
    expect(p.status).toBe(status);
    expect(p.body).toMatchObject({ type, status, instance: RID });
    expect(p.headers["content-type"]).toBe("application/problem+json");
  });

  it("lists field errors, the entitlement and Retry-After", () => {
    expect(toProblem(validationError({ slug: ["Taken", "Too short"] })).body.errors).toEqual([
      { path: "slug", message: "Taken" }, { path: "slug", message: "Too short" },
    ]);
    expect(toProblem(limitExceeded("sites")).body.entitlement).toBe("sites");
    expect(toProblem(rateLimited(30)).headers["retry-after"]).toBe("30");
  });

  it("never includes the message of an unexpected error", async () => {
    const res = problemResponse(new Error("password=hunter2 at db"), RID);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("hunter2");
    expect(JSON.parse(body)).toEqual({ type: "urn:forge:problem:internal", title: "Internal error", status: 500, instance: RID });
  });

  it("AppError keeps its cause for logs", () => {
    const cause = new Error("ECONNRESET");
    expect(new AppError("Unavailable", "x", { cause }).cause).toBe(cause);
  });
});
