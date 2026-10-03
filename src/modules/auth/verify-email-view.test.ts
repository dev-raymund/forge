import { describe, expect, it } from "vitest";
import type { AuthUser } from "./shared";
import { verifyEmailView } from "./verify-email-view";

const user = (emailVerified: boolean): AuthUser => ({ id: "u1", email: "ada@example.test", name: "Ada", emailVerified, image: null });

describe("verifyEmailView", () => {
  it.each<[string, AuthUser | null, { error?: string; status?: string }, ReturnType<typeof verifyEmailView>]>([
    ["signed in, not verified", user(false), {}, { kind: "pending", email: "ada@example.test" }],
    ["signed in and verified", user(true), {}, { kind: "verified" }],
    ["signed in, arrived from a good link", user(true), { status: "verified" }, { kind: "verified" }],
    ["signed in, bad link: a new one can be sent", user(false), { error: "TOKEN_EXPIRED" }, { kind: "invalid", email: "ada@example.test" }],
    ["signed in and verified, old link: verified wins", user(true), { error: "INVALID_TOKEN" }, { kind: "verified" }],
    ["anonymous", null, {}, { kind: "anonymous" }],
    ["anonymous, arrived from a good link", null, { status: "verified" }, { kind: "confirmed" }],
    ["anonymous, bad link", null, { error: "INVALID_TOKEN" }, { kind: "invalid" }],
    ["anonymous, bad link wins over a status", null, { error: "INVALID_TOKEN", status: "verified" }, { kind: "invalid" }],
    ["an unknown status means nothing", null, { status: "yes" }, { kind: "anonymous" }],
  ])("%s", (_name, who, query, expected) => expect(verifyEmailView(who, query)).toEqual(expected));

  it("the query string never makes a signed-in user look verified", () => {
    expect(verifyEmailView(user(false), { status: "verified" })).toEqual({ kind: "pending", email: "ada@example.test" });
  });

  it("every kind of bad link gets the same view (expired, invalid, unknown user)", () => {
    const views = ["TOKEN_EXPIRED", "INVALID_TOKEN", "USER_NOT_FOUND", "anything"].map((error) => verifyEmailView(null, { error }));
    expect(new Set(views.map((v) => JSON.stringify(v))).size).toBe(1);
  });
});
