import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import { authErrorToAppError } from "./errors";

type Status = ConstructorParameters<typeof APIError>[0];
const apiError = (status: Status, code?: string, message = "Better Auth internal text") =>
  new APIError(status, code ? { code, message } : { message });

const CREDENTIALS = { kind: "Validation", fieldErrors: { _form: ["Email or password is incorrect."] } };
const LINK = { kind: "Validation", fieldErrors: { _form: ["This link is invalid or has expired. Request a new one."] } };
const EXISTS = { kind: "Validation", fieldErrors: { email: ["An account with this email already exists."] } };

describe("authErrorToAppError", () => {
  it.each<[string, Status, object]>([
    ["INVALID_EMAIL_OR_PASSWORD", "UNAUTHORIZED", CREDENTIALS],
    ["INVALID_PASSWORD", "BAD_REQUEST", CREDENTIALS],
    ["CREDENTIAL_ACCOUNT_NOT_FOUND", "BAD_REQUEST", CREDENTIALS],
    ["USER_NOT_FOUND", "BAD_REQUEST", CREDENTIALS],
    ["INVALID_EMAIL", "BAD_REQUEST", { kind: "Validation", fieldErrors: { email: ["Enter a valid email address."] } }],
    ["USER_ALREADY_EXISTS", "UNPROCESSABLE_ENTITY", EXISTS],
    ["USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", "UNPROCESSABLE_ENTITY", EXISTS],
    ["PASSWORD_TOO_SHORT", "BAD_REQUEST", { kind: "Validation", fieldErrors: { password: ["Use at least 12 characters."] } }],
    ["PASSWORD_TOO_LONG", "BAD_REQUEST", { kind: "Validation", fieldErrors: { password: ["This password is too long."] } }],
    ["INVALID_TOKEN", "BAD_REQUEST", LINK],
    ["TOKEN_EXPIRED", "UNAUTHORIZED", LINK],
    ["EMAIL_NOT_VERIFIED", "FORBIDDEN", { kind: "Forbidden", message: "Verify your email address to continue." }],
    ["SESSION_EXPIRED", "UNAUTHORIZED", { kind: "Unauthenticated" }],
    ["FAILED_TO_GET_SESSION", "INTERNAL_SERVER_ERROR", { kind: "Unauthenticated" }],
  ])("%s", (code, status, expected) => expect(authErrorToAppError(apiError(status, code))).toMatchObject(expected));

  it("a wrong password, an unknown email and a missing credential account are indistinguishable", () => {
    const results = ["INVALID_EMAIL_OR_PASSWORD", "INVALID_PASSWORD", "CREDENTIAL_ACCOUNT_NOT_FOUND", "USER_NOT_FOUND"].map((code) => {
      const error = authErrorToAppError(apiError("UNAUTHORIZED", code))!;
      return { kind: error.kind, message: error.message, fieldErrors: error.fieldErrors };
    });
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("an invalid token and an expired token are indistinguishable", () => {
    const [a, b] = ["INVALID_TOKEN", "TOKEN_EXPIRED"].map((code) => authErrorToAppError(apiError("BAD_REQUEST", code))!);
    expect({ kind: a!.kind, message: a!.message, fieldErrors: a!.fieldErrors }).toEqual({ kind: b!.kind, message: b!.message, fieldErrors: b!.fieldErrors });
  });

  it("falls back on the status for unknown codes: 429 → RateLimited, 401 → Unauthenticated", () => {
    expect(authErrorToAppError(apiError("TOO_MANY_REQUESTS"))).toMatchObject({ kind: "RateLimited" });
    expect(authErrorToAppError(apiError("UNAUTHORIZED", "SOMETHING_NEW"))).toMatchObject({ kind: "Unauthenticated" });
  });

  it("never passes Better Auth's own text through", () => {
    const secret = "relation \"auth_sessions\" does not exist";
    for (const [status, code] of [["UNAUTHORIZED", "INVALID_EMAIL_OR_PASSWORD"], ["BAD_REQUEST", "INVALID_TOKEN"], ["TOO_MANY_REQUESTS", undefined]] as const) {
      const error = authErrorToAppError(apiError(status, code, secret))!;
      expect(JSON.stringify({ message: error.message, fieldErrors: error.fieldErrors })).not.toContain("auth_sessions");
    }
  });

  it("returns null for anything unmapped, so callers treat it as unexpected", () => {
    expect(authErrorToAppError(apiError("INTERNAL_SERVER_ERROR", "FAILED_TO_CREATE_USER"))).toBeNull();
    expect(authErrorToAppError(apiError("BAD_REQUEST"))).toBeNull();
    expect(authErrorToAppError(new Error("boom"))).toBeNull();
    expect(authErrorToAppError("a string")).toBeNull();
    expect(authErrorToAppError(null)).toBeNull();
  });
});
