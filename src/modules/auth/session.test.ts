import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleted: unknown[] = [];
vi.mock("@/platform/db/identity", () => ({
  identityDb: () => ({ delete: () => ({ where: async (condition: unknown) => void deleted.push(condition) }) }),
}));

import { SESSION_ABSOLUTE_SECONDS, setAuthForTests, type Auth } from "./auth";
import { assertAuthenticated, assertVerified, resolveAuth, toActor, toAuthenticated, withinAbsoluteLifetime } from "./session";
import { ANONYMOUS, type Authenticated } from "./shared";

const DAY = 24 * 3600 * 1000;
const now = new Date("2026-10-03T12:00:00Z");

/** What Better Auth's getSession returns: more than Forge ever passes on. */
const betterAuthSession = (over: { createdAt?: Date; expiresAt?: Date; emailVerified?: boolean; image?: string | null } = {}) => ({
  user: {
    id: "user-1",
    email: "ada@example.test",
    name: "Ada",
    emailVerified: over.emailVerified ?? false,
    image: over.image,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  },
  session: {
    id: "session-1",
    userId: "user-1",
    token: "raw-session-token",
    ipAddress: "203.0.113.7",
    userAgent: "UA",
    createdAt: over.createdAt ?? now,
    updatedAt: now,
    expiresAt: over.expiresAt ?? new Date(now.getTime() + 7 * DAY),
  },
});

/** A stand-in for Better Auth that returns `result` for any request. */
function fakeAuth(result: ReturnType<typeof betterAuthSession> | null) {
  const getSession = vi.fn(async () => result);
  setAuthForTests({ api: { getSession } } as unknown as Auth);
  return getSession;
}

beforeEach(() => {
  deleted.length = 0;
  vi.useFakeTimers({ now });
});
afterEach(() => {
  vi.useRealTimers();
  setAuthForTests(null);
});

describe("toAuthenticated", () => {
  it("keeps only Forge's fields: no token, IP address or user agent", () => {
    const auth = toAuthenticated(betterAuthSession({ image: "https://example.test/a.png" }));
    expect(auth).toEqual({
      user: { id: "user-1", email: "ada@example.test", name: "Ada", emailVerified: false, image: "https://example.test/a.png" },
      session: { id: "session-1", createdAt: now, expiresAt: new Date(now.getTime() + 7 * DAY) },
    });
    expect(JSON.stringify(auth)).not.toContain("raw-session-token");
    expect(JSON.stringify(auth)).not.toContain("203.0.113.7");
  });

  it("normalises a missing image to null", () => {
    expect(toAuthenticated(betterAuthSession()).user.image).toBeNull();
    expect(toAuthenticated(betterAuthSession({ image: null })).user.image).toBeNull();
  });
});

describe("withinAbsoluteLifetime (30-day cap)", () => {
  const created = new Date("2026-09-01T00:00:00Z");
  const at = (ms: number) => new Date(created.getTime() + ms);

  it.each([
    ["just created", 0, true],
    ["29 days", 29 * DAY, true],
    ["one millisecond before 30 days", 30 * DAY - 1, true],
    ["exactly 30 days", 30 * DAY, false],
    ["31 days", 31 * DAY, false],
  ])("%s → %s", (_name, age, expected) => expect(withinAbsoluteLifetime(created, at(age))).toBe(expected));

  it("is 30 days", () => expect(SESSION_ABSOLUTE_SECONDS).toBe(30 * 24 * 3600));
});

describe("resolveAuth", () => {
  it("passes the request headers to Better Auth and returns Forge's shape", async () => {
    const getSession = fakeAuth(betterAuthSession({ emailVerified: true }));
    const headers = new Headers({ cookie: "better-auth.session_token=x" });
    const auth = await resolveAuth(headers);
    expect(getSession).toHaveBeenCalledWith({ headers });
    expect(auth?.user).toMatchObject({ id: "user-1", emailVerified: true });
    expect(auth?.session.id).toBe("session-1");
    expect(deleted).toEqual([]);
  });

  it("is anonymous (null) when Better Auth finds no session", async () => {
    fakeAuth(null);
    expect(await resolveAuth(new Headers())).toBeNull();
    expect(deleted).toEqual([]);
  });

  it("rejects and deletes a session older than 30 days, even though Better Auth still accepts it", async () => {
    fakeAuth(betterAuthSession({ createdAt: new Date(now.getTime() - 30 * DAY), expiresAt: new Date(now.getTime() + 3 * DAY) }));
    expect(await resolveAuth(new Headers())).toBeNull();
    expect(deleted).toHaveLength(1);
  });

  it("accepts a session one second inside the cap", async () => {
    fakeAuth(betterAuthSession({ createdAt: new Date(now.getTime() - 30 * DAY + 1000) }));
    expect(await resolveAuth(new Headers())).not.toBeNull();
    expect(deleted).toEqual([]);
  });
});

describe("guards and actors", () => {
  const auth: Authenticated = toAuthenticated(betterAuthSession());
  const verified: Authenticated = toAuthenticated(betterAuthSession({ emailVerified: true }));

  it("assertAuthenticated returns the session or throws Unauthenticated", () => {
    expect(assertAuthenticated(auth)).toBe(auth);
    expect(() => assertAuthenticated(null)).toThrow(expect.objectContaining({ kind: "Unauthenticated", message: "Sign in to continue." }));
  });

  it("assertVerified returns a verified user or throws Forbidden", () => {
    expect(assertVerified(verified.user)).toBe(verified.user);
    expect(() => assertVerified(auth.user)).toThrow(expect.objectContaining({ kind: "Forbidden" }));
  });

  it("toActor describes who is acting, and nothing about organizations", () => {
    expect(toActor(auth)).toEqual({ kind: "user", userId: "user-1", sessionId: "session-1", emailVerified: false });
    expect(toActor(verified)).toMatchObject({ emailVerified: true });
    expect(toActor(null)).toBe(ANONYMOUS);
    expect(ANONYMOUS).toEqual({ kind: "anonymous" });
    expect(Object.keys(toActor(auth))).not.toContain("organizationId");
  });
});
