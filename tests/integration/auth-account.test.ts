import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLogs } from "@/modules/audit/schema";
import { changePassword, signInMethods, updateProfile } from "@/modules/auth/account.service";
import { createAuth, SESSION_ABSOLUTE_SECONDS, setAuthForTests } from "@/modules/auth/auth";
import { SESSION_COOKIE, SESSION_IDLE_SECONDS } from "@/modules/auth/cookie";
import {
  requestPasswordReset, resetPassword, signIn, signOut, signUp, startGoogleSignIn, type AuthRequest,
} from "@/modules/auth/credentials.service";
import { authAccounts, authSessions, users } from "@/modules/auth/schema";
import { resolveAuth } from "@/modules/auth/session";
import { listSessions, revokeOtherSessions, revokeSession } from "@/modules/auth/sessions.service";
import { withPlatform, withTenant } from "@/platform/db/tenant";
import { emailSend } from "@/platform/email";
import { setEmailProviderForTests } from "@/platform/email/get-provider";
import { CaptureEmailProvider } from "@/platform/email/providers/capture";
import { isAppError } from "@/platform/errors";
import { createJobRegistry, runJobs } from "@/platform/jobs";
import { jobs } from "@/platform/jobs/schema";
import { setLogSink } from "@/platform/observability/logger";
import { createOrganization } from "../fixtures/factories";

/**
 * M2-4: the account page's use cases against real Postgres. Sessions are real
 * rows created by real sign-ins; "revoked" means the row is gone and the old
 * cookie stops resolving, not that a cookie was cleared somewhere.
 */

const BASE = "http://localhost:3000"; // APP_ORIGIN in tests/setup/integration-env.ts
const SECRET = "integration-secret-integration-secret-0123";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "an entirely new passphrase";
const GOOGLE = { clientId: "forge-test.apps.googleusercontent.com", clientSecret: "google-client-secret-for-tests" };
const DAY = 24 * 3600 * 1000;

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const FIREFOX_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0";

const auth = createAuth({ baseURL: BASE, secret: SECRET, google: GOOGLE });
const capture = new CaptureEmailProvider();
const registry = createJobRegistry([emailSend]);
const logs: string[] = [];

beforeAll(() => {
  setEmailProviderForTests(capture);
  setLogSink((_level, line) => logs.push(line));
});
afterAll(async () => {
  // Leave the worker's queue as we found it: other suites count the jobs they run.
  await withPlatform((tx) => tx.delete(jobs).where(eq(jobs.type, "email.send")));
  setAuthForTests(null);
  setEmailProviderForTests(null);
  setLogSink(null);
});
beforeEach(() => {
  setAuthForTests(auth);
  capture.clear();
  logs.length = 0;
});

const newEmail = () => `account-${uuidv7()}@example.test`;
const identity = <T>(fn: Parameters<typeof withPlatform<T>>[0]) => withPlatform(fn);
const deliver = () => runJobs({ registry, budgetMs: 20_000 });

/** What a browser on the app would send with a form post. */
const browser = (init: Record<string, string> = {}): AuthRequest => ({
  headers: new Headers({ origin: BASE, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "user-agent": CHROME_MAC, ...init }),
});
const cookieHeader = (setCookies: string[]) =>
  setCookies
    .map((c) => c.split(";")[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
/** The same browser, now carrying the cookies it was given. */
const withCookies = (setCookies: string[], init: Record<string, string> = {}) => browser({ ...init, cookie: cookieHeader(setCookies) });
const whoIs = (request: AuthRequest) => resolveAuth(request.headers);
const must = async (request: AuthRequest) => {
  const resolved = await whoIs(request);
  if (!resolved) throw new Error("expected a signed-in request");
  return resolved;
};

/** An account with one session (the sign-up). */
async function newAccount(name = "Ada Account") {
  const email = newEmail();
  const { setCookies } = await signUp({ name, email, password: PASSWORD }, browser({ "x-forwarded-for": "198.51.100.10" }));
  const request = withCookies(setCookies, { "x-forwarded-for": "198.51.100.10" });
  return { email, request, userId: (await must(request)).user.id };
}
/** Another browser logging in to the same account: a second, independent session. */
async function anotherSession(email: string, userAgent: string, ip: string, password = PASSWORD) {
  const { setCookies } = await signIn({ email, password }, browser({ "user-agent": userAgent, "x-forwarded-for": ip }));
  return withCookies(setCookies, { "user-agent": userAgent, "x-forwarded-for": ip });
}

async function failureOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("expected the use case to fail");
}

const sessionRows = (userId: string) => identity((tx) => tx.select().from(authSessions).where(eq(authSessions.userId, userId)));

/**
 * Org-less audit rows are invisible to every application role (the table's
 * policy), so the test reads them as the table's owner with FORCE lifted for
 * one rolled-back transaction.
 */
async function auditRowsFor(userId: string) {
  const owner = new pg.Client({ connectionString: process.env.TEST_WORKER_OWNER_URL });
  await owner.connect();
  try {
    await owner.query("begin");
    await owner.query("alter table audit_logs no force row level security");
    const { rows } = await owner.query(
      "select action, organization_id, site_id, actor_type, actor_id, actor_label, resource_type, resource_id, request_id, ip, metadata from audit_logs where actor_id = $1 order by created_at, id",
      [userId],
    );
    return rows as {
      action: string; organization_id: string | null; site_id: string | null; actor_type: string; actor_id: string; actor_label: string;
      resource_type: string; resource_id: string; request_id: string; ip: string; metadata: Record<string, unknown>;
    }[];
  } finally {
    await owner.query("rollback").catch(() => undefined);
    await owner.end();
  }
}
const actionsOf = async (userId: string) => (await auditRowsFor(userId)).map((row) => row.action);

describe("active sessions", () => {
  /** A with three sessions (A is the caller), B with one. */
  async function threeSessions() {
    const a = await newAccount("User A");
    const b = await newAccount("User B");
    const second = await anotherSession(a.email, SAFARI_IPHONE, "203.0.113.20");
    const third = await anotherSession(a.email, FIREFOX_WINDOWS, "203.0.113.30");
    return { a, b, second, third };
  }

  it("lists the caller's own sessions, the current one first, with only what a person needs to recognise them", async () => {
    const { a, b, second } = await threeSessions();
    const list = await listSessions(await must(a.request));

    expect(list).toHaveLength(3);
    expect(list.map((s) => s.current)).toEqual([true, false, false]);
    expect(list[0]).toMatchObject({ device: "Chrome on macOS", ipAddress: "198.51.100.10" });
    expect(list.map((s) => s.device).sort()).toEqual(["Chrome on macOS", "Firefox on Windows", "Safari on iOS"]);
    expect(list.map((s) => s.ipAddress).sort()).toEqual(["198.51.100.10", "203.0.113.20", "203.0.113.30"]);
    for (const session of list) {
      expect(Object.keys(session).sort()).toEqual(["createdAt", "current", "device", "handle", "ipAddress", "lastActiveAt"]);
      expect(session.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    }

    // "Current" is relative to who is asking.
    const fromSecond = await listSessions(await must(second));
    expect(fromSecond.find((s) => s.current)?.device).toBe("Safari on iOS");
    // B sees one session: its own.
    const forB = await listSessions(await must(b.request));
    expect(forB).toHaveLength(1);
    expect(forB[0]).toMatchObject({ current: true });
  });

  it("never exposes a session id, a token or a raw user agent; handles are opaque and per user", async () => {
    const { a, b } = await threeSessions();
    const [listA, listB] = await Promise.all([listSessions(await must(a.request)), listSessions(await must(b.request))]);
    const rows = [...(await sessionRows(a.userId)), ...(await sessionRows(b.userId))];
    const exposed = JSON.stringify([listA, listB]);
    for (const row of rows) {
      expect(exposed).not.toContain(row.id);
      expect(exposed).not.toContain(row.token);
    }
    expect(exposed).not.toContain("Mozilla/5.0");

    const handles = [...listA, ...listB].map((s) => s.handle);
    expect(new Set(handles).size).toBe(4);
    for (const handle of handles) expect(handle).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The same session gets the same handle every time (the page and the action must agree).
    expect((await listSessions(await must(a.request))).map((s) => s.handle)).toEqual(listA.map((s) => s.handle));
  });

  it("ends one other session: it stops working at once, the caller and the rest keep working", async () => {
    const { a, second, third } = await threeSessions();
    const list = await listSessions(await must(a.request));
    const target = list.find((s) => s.device === "Safari on iOS")!;

    await revokeSession(target.handle, a.request);

    expect(await whoIs(second)).toBeNull(); // the old cookie is still in that browser; the server no longer knows it
    expect(await whoIs(a.request)).not.toBeNull();
    expect(await whoIs(third)).not.toBeNull();
    expect(await sessionRows(a.userId)).toHaveLength(2); // the row is gone, not flagged
    expect((await listSessions(await must(a.request))).map((s) => s.device).sort()).toEqual(["Chrome on macOS", "Firefox on Windows"]);
    // A revoked session can do nothing further.
    expect((await failureOf(() => revokeOtherSessions(second))).kind).toBe("Unauthenticated");
    expect((await failureOf(() => revokeSession(list[0]!.handle, second))).kind).toBe("Unauthenticated");
  });

  it("cannot end another user's session, whatever handle is sent", async () => {
    const { a, b } = await threeSessions();
    const [handleOfB] = (await listSessions(await must(b.request))).map((s) => s.handle);
    const rowsOfB = await sessionRows(b.userId);
    const rowsOfA = await sessionRows(a.userId);

    const attempts = [handleOfB!, rowsOfB[0]!.id, rowsOfB[0]!.token, rowsOfA[1]!.id, rowsOfA[1]!.token, "", "x", "x".repeat(4000), uuidv7(), "../../etc/passwd"];
    for (const attempt of attempts) {
      expect((await failureOf(() => revokeSession(attempt, a.request))).kind, attempt.slice(0, 20)).toBe("NotFound");
    }
    expect(await whoIs(b.request)).not.toBeNull();
    expect(await sessionRows(b.userId)).toHaveLength(1);
    expect(await sessionRows(a.userId)).toHaveLength(3); // nothing of A's was touched either
  });

  it("the current session is ended by logging out, not from the list", async () => {
    const { a } = await threeSessions();
    const current = (await listSessions(await must(a.request))).find((s) => s.current)!;
    const error = await failureOf(() => revokeSession(current.handle, a.request));
    expect(error).toMatchObject({ kind: "Validation", message: "To end this session, log out." });
    expect(await whoIs(a.request)).not.toBeNull();
  });

  it("ends all other sessions and keeps the caller's; another user is not affected", async () => {
    const { a, b, second, third } = await threeSessions();

    expect(await revokeOtherSessions(a.request)).toEqual({ revoked: 2 });

    expect(await whoIs(a.request)).not.toBeNull();
    expect(await whoIs(second)).toBeNull();
    expect(await whoIs(third)).toBeNull();
    expect(await whoIs(b.request)).not.toBeNull();
    const left = await listSessions(await must(a.request));
    expect(left).toHaveLength(1);
    expect(left[0]!.current).toBe(true);
    expect(await revokeOtherSessions(a.request)).toEqual({ revoked: 0 });
  });

  it("needs a session, and a request from this app", async () => {
    const { a } = await threeSessions();
    const [, other] = await listSessions(await must(a.request));
    expect((await failureOf(() => revokeSession(other!.handle, browser()))).kind).toBe("Unauthenticated");
    expect((await failureOf(() => revokeOtherSessions(browser()))).kind).toBe("Unauthenticated");
    expect((await failureOf(() => revokeOtherSessions(browser({ cookie: `${SESSION_COOKIE}=forged.value` })))).kind).toBe("Unauthenticated");

    const foreign: AuthRequest = { headers: new Headers({ origin: "https://evil.example", "sec-fetch-site": "cross-site", cookie: a.request.headers.get("cookie")! }) };
    expect((await failureOf(() => revokeOtherSessions(foreign))).kind).toBe("Forbidden");
    expect((await failureOf(() => revokeSession(other!.handle, foreign))).kind).toBe("Forbidden");
    expect(await sessionRows(a.userId)).toHaveLength(3);
  });
});

describe("session lifetime is unchanged by the account page", () => {
  it("looking at the list extends nothing", async () => {
    const a = await newAccount();
    await anotherSession(a.email, SAFARI_IPHONE, "203.0.113.20");
    const before = (await sessionRows(a.userId)).map((r) => [r.id, r.expiresAt.getTime(), r.updatedAt.getTime()]).sort();
    const resolved = await must(a.request);
    for (let i = 0; i < 3; i++) await listSessions(resolved);
    expect((await sessionRows(a.userId)).map((r) => [r.id, r.expiresAt.getTime(), r.updatedAt.getTime()]).sort()).toEqual(before);
  });

  it("idle-expired and over-age sessions are not listed, cannot be used, and cannot be ended twice", async () => {
    const a = await newAccount();
    const idle = await anotherSession(a.email, SAFARI_IPHONE, "203.0.113.20");
    const old = await anotherSession(a.email, FIREFOX_WINDOWS, "203.0.113.30");
    const [idleId, oldId] = [(await must(idle)).session.id, (await must(old)).session.id];
    await identity((tx) => tx.update(authSessions).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(authSessions.id, idleId)));
    await identity((tx) =>
      tx.update(authSessions).set({ createdAt: new Date(Date.now() - SESSION_ABSOLUTE_SECONDS * 1000 - DAY), expiresAt: new Date(Date.now() + DAY) })
        .where(eq(authSessions.id, oldId)),
    );

    const list = await listSessions(await must(a.request));
    expect(list.map((s) => s.device)).toEqual(["Chrome on macOS"]);
    expect(await whoIs(idle)).toBeNull(); // 7 days without use
    expect(await whoIs(old)).toBeNull(); // 30 days since login, however active
    expect(await revokeOtherSessions(a.request)).toEqual({ revoked: 0 });
  });

  it("an active session still slides by 7 days, and never past 30 days from login", async () => {
    const a = await newAccount();
    const [row] = await sessionRows(a.userId);
    // Due for a refresh, logged in 2 days ago: slides to now + 7 days.
    await identity((tx) => tx.update(authSessions).set({ createdAt: new Date(Date.now() - 2 * DAY), expiresAt: new Date(Date.now() + 5 * DAY) }).where(eq(authSessions.id, row!.id)));
    await whoIs(a.request);
    const slid = (await sessionRows(a.userId))[0]!;
    expect(Math.abs(slid.expiresAt.getTime() - (Date.now() + SESSION_IDLE_SECONDS * 1000))).toBeLessThan(60_000);
    // Logged in 29.5 days ago: the refresh stops at the 30-day cap.
    const createdAt = new Date(Date.now() - 29.5 * DAY);
    await identity((tx) => tx.update(authSessions).set({ createdAt, expiresAt: new Date(Date.now() + 0.25 * DAY) }).where(eq(authSessions.id, row!.id)));
    await whoIs(a.request);
    expect((await sessionRows(a.userId))[0]!.expiresAt.getTime()).toBe(createdAt.getTime() + SESSION_ABSOLUTE_SECONDS * 1000);
  });
});

describe("profile", () => {
  const rawUpdate = (request: AuthRequest, body: Record<string, unknown>) =>
    auth.handler(
      new Request(`${BASE}/api/auth/update-user`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: request.headers.get("cookie")! },
        body: JSON.stringify(body),
      }),
    );

  it("changes the caller's own name, and nothing else", async () => {
    const a = await newAccount("Before");
    const b = await newAccount("Somebody Else");
    await updateProfile({ name: "After" }, a.request);

    expect((await must(a.request)).user).toMatchObject({ name: "After", email: a.email, emailVerified: false });
    expect((await must(b.request)).user.name).toBe("Somebody Else");
    expect((await failureOf(() => updateProfile({ name: "Nobody" }, browser()))).kind).toBe("Unauthenticated");
  });

  it("the endpoint itself refuses every field but the name: no picture URL, no email, no verified flag", async () => {
    const a = await newAccount("Fixed");
    for (const body of [
      { image: "https://tracker.example/pixel.png" },
      { name: "Sneaky", image: "https://tracker.example/pixel.png" },
      { name: "Sneaky", emailVerified: true },
      { email: "someone-else@example.test" },
      { name: "Sneaky", role: "admin" },
    ]) {
      const response = await rawUpdate(a.request, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const [row] = await identity((tx) => tx.select().from(users).where(eq(users.id, a.userId)));
    expect(row).toMatchObject({ name: "Fixed", email: a.email, emailVerified: false, image: null });
    expect((await rawUpdate(a.request, { name: "Allowed" })).status).toBe(200);
  });
});

describe("change password", () => {
  it("a wrong current password changes nothing and says which field is wrong", async () => {
    const a = await newAccount();
    const second = await anotherSession(a.email, SAFARI_IPHONE, "203.0.113.20");
    await deliver();
    capture.clear();

    const error = await failureOf(() => changePassword({ currentPassword: "not my current password", newPassword: NEW_PASSWORD }, a.request));
    expect(error).toMatchObject({ kind: "Validation", fieldErrors: { currentPassword: ["Your current password is incorrect."] } });

    expect(await whoIs(a.request)).not.toBeNull();
    expect(await whoIs(second)).not.toBeNull();
    await expect(signIn({ email: a.email, password: PASSWORD }, browser())).resolves.toBeDefined();
    await deliver();
    expect(capture.messages).toEqual([]);
    expect(await actionsOf(a.userId)).not.toContain("auth.password_changed");
  });

  it("a correct change: new password works, every other session is revoked, this browser stays signed in on a new session", async () => {
    const a = await newAccount();
    const second = await anotherSession(a.email, SAFARI_IPHONE, "203.0.113.20");
    const third = await anotherSession(a.email, FIREFOX_WINDOWS, "203.0.113.30");
    const before = await must(a.request);
    await deliver();
    capture.clear();

    const { setCookies } = await changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, a.request);

    expect(await whoIs(second)).toBeNull();
    expect(await whoIs(third)).toBeNull();
    expect(await whoIs(a.request)).toBeNull(); // the cookie from before the change is revoked as well…
    const after = await must(withCookies(setCookies)); // …and replaced
    expect(after.user.id).toBe(before.user.id);
    expect(after.session.id).not.toBe(before.session.id);
    expect(await sessionRows(a.userId)).toHaveLength(1);
    expect(setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toMatch(/HttpOnly/i);

    expect((await failureOf(() => signIn({ email: a.email, password: PASSWORD }, browser()))).message).toBe("Email or password is incorrect.");
    await expect(signIn({ email: a.email, password: NEW_PASSWORD }, browser())).resolves.toBeDefined();
  });

  it("queues the same password-changed notice as a reset, and writes the audit row", async () => {
    const a = await newAccount();
    await deliver();
    capture.clear();
    await changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, a.request);
    await deliver();

    const notices = capture.messages.filter((m) => m.tags?.template === "password-changed");
    expect(notices.map((m) => m.to)).toEqual([a.email]);
    for (const secret of [PASSWORD, NEW_PASSWORD]) expect(notices[0]!.text + notices[0]!.html).not.toContain(secret);

    const rows = await auditRowsFor(a.userId);
    expect(rows.filter((r) => r.action === "auth.password_changed").map((r) => r.metadata)).toEqual([{ via: "change" }]);
    // The fresh session after the change is the same person continuing, not a new login.
    expect(rows.filter((r) => r.action === "auth.login")).toHaveLength(1);
    expect(logs.join("\n") + JSON.stringify(rows)).not.toContain(NEW_PASSWORD);
  });

  it("enforces the password rules on the server, whatever the form let through", async () => {
    const a = await newAccount();
    const short = await failureOf(() => changePassword({ currentPassword: PASSWORD, newPassword: "elevenchars" }, a.request));
    expect(short.fieldErrors).toEqual({ newPassword: ["Use at least 12 characters."] });
    const long = await failureOf(() => changePassword({ currentPassword: PASSWORD, newPassword: "x".repeat(129) }, a.request));
    expect(long.fieldErrors).toEqual({ newPassword: ["Use at most 128 characters."] });
    await expect(signIn({ email: a.email, password: PASSWORD }, browser())).resolves.toBeDefined();
  });

  it("needs a session", async () => {
    expect((await failureOf(() => changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, browser()))).kind).toBe("Unauthenticated");
  });

  it("is rate limited like signing in: the fourth attempt in ten seconds from one address is refused", async () => {
    setAuthForTests(createAuth({ baseURL: BASE, secret: SECRET, rateLimit: true }));
    const ip = `198.51.100.${Math.floor(Math.random() * 100) + 100}`;
    const email = newEmail();
    const { setCookies } = await signUp({ name: "Limited", email, password: PASSWORD }, browser({ "x-forwarded-for": ip }));
    const request = withCookies(setCookies, { "x-forwarded-for": ip });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const error = await failureOf(() => changePassword({ currentPassword: `guess number ${attempt}`, newPassword: NEW_PASSWORD }, request));
      expect(error.fieldErrors).toEqual({ currentPassword: ["Your current password is incorrect."] });
    }
    expect(await failureOf(() => changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, request))).toMatchObject({ kind: "RateLimited" });
  });
});

describe("an account that signs in with Google and has no password", () => {
  let asserted: { sub: string; email: string; email_verified: boolean; name: string };
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  beforeEach(() => {
    // Google's token endpoint is the only thing replaced (see auth-google.test.ts).
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.url !== "https://oauth2.googleapis.com/token") throw new Error(`unexpected outbound request: ${request.url}`);
      const claims = { iss: "https://accounts.google.com", aud: GOOGLE.clientId, exp: Math.floor(Date.now() / 1000) + 3600, ...asserted };
      return Response.json({ access_token: "ya29.x", id_token: `${b64({ alg: "RS256" })}.${b64(claims)}.${b64("sig")}`, expires_in: 3599, token_type: "Bearer" });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function googleAccount() {
    asserted = { sub: `${Date.now()}${Math.floor(Math.random() * 1e9)}`, email: newEmail(), email_verified: true, name: "Grace Google" };
    const started = await startGoogleSignIn({ next: "/account" }, browser());
    const url = new URL(`${BASE}/api/auth/callback/google`);
    url.searchParams.set("code", "code");
    url.searchParams.set("state", new URL(started.url).searchParams.get("state")!);
    const response = await auth.handler(new Request(url, { headers: { cookie: cookieHeader(started.setCookies), "x-forwarded-for": "203.0.113.99" } }));
    const request = withCookies(response.headers.getSetCookie());
    return { email: asserted.email, request, userId: (await must(request)).user.id };
  }

  it("shows Google as its only sign-in method; changing a password it does not have is refused plainly", async () => {
    const g = await googleAccount();
    expect(await signInMethods(g.userId)).toEqual({ password: false, google: true });
    const error = await failureOf(() => changePassword({ currentPassword: "anything at all here", newPassword: NEW_PASSWORD }, g.request));
    expect(error).toMatchObject({ kind: "Validation", message: "This account has no password yet. Use the link below to set one." });
    expect(await signInMethods(g.userId)).toEqual({ password: false, google: true });
  });

  it("gets a password through the emailed link, after which both methods work", async () => {
    const g = await googleAccount();
    await requestPasswordReset({ email: g.email }, g.request);
    await deliver();
    const link = capture.messages.find((m) => m.to === g.email && m.tags?.template === "reset-password")!.text.match(/https?:\/\/\S+/)![0];
    const landing = await auth.handler(new Request(link));
    const token = new URL(landing.headers.get("location")!, BASE).searchParams.get("token")!;
    await resetPassword({ token, password: NEW_PASSWORD }, browser());

    expect(await signInMethods(g.userId)).toEqual({ password: true, google: true });
    await expect(signIn({ email: g.email, password: NEW_PASSWORD }, browser())).resolves.toBeDefined();
    const accounts = await identity((tx) => tx.select().from(authAccounts).where(eq(authAccounts.userId, g.userId)));
    expect(accounts.map((a) => a.providerId).sort()).toEqual(["credential", "google"]);
  });

  it("a password account shows only the password", async () => {
    const a = await newAccount();
    expect(await signInMethods(a.userId)).toEqual({ password: true, google: false });
  });

  it("a Google login is audited with its method", async () => {
    const g = await googleAccount();
    const rows = await auditRowsFor(g.userId);
    expect(rows.map((r) => [r.action, r.metadata])).toEqual([["auth.login", { method: "google" }]]);
    expect(rows[0]).toMatchObject({ ip: "203.0.113.99", actor_label: g.email });
  });
});

describe("audit trail of account events (org-less rows)", () => {
  it("records login, logout and password change, with who, from where, and which request", async () => {
    const email = newEmail();
    const requestId = uuidv7();
    const { setCookies } = await signUp({ name: "Audited", email, password: PASSWORD }, browser({ "x-forwarded-for": "203.0.113.7", "x-request-id": requestId }));
    const first = withCookies(setCookies, { "x-forwarded-for": "203.0.113.7" });
    const userId = (await must(first)).user.id;

    const second = await anotherSession(email, SAFARI_IPHONE, "203.0.113.8, 10.0.0.1");
    await failureOf(() => signIn({ email, password: "a wrong secret passphrase" }, browser())); // not a login
    await signOut(second);
    await changePassword({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, first);

    const rows = await auditRowsFor(userId);
    expect(rows.map((r) => [r.action, r.metadata])).toEqual([
      ["auth.login", { method: "sign-up" }],
      ["auth.login", { method: "password" }],
      ["auth.logout", {}],
      ["auth.password_changed", { via: "change" }],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        organization_id: null, site_id: null, actor_type: "user", actor_id: userId, actor_label: email, resource_type: "user", resource_id: userId,
      });
    }
    expect(rows[0]).toMatchObject({ ip: "203.0.113.7", request_id: requestId });
    expect(rows[1]!.ip).toBe("203.0.113.8"); // the client's address, not the proxy chain
    const stored = JSON.stringify(rows);
    for (const secret of [PASSWORD, NEW_PASSWORD, "a wrong secret passphrase", cookieHeader(setCookies).split("=")[1]!.slice(0, 20)]) {
      expect(stored).not.toContain(secret);
    }
  });

  it("a password reset is recorded as a password change, not as a login", async () => {
    const a = await newAccount();
    await deliver();
    capture.clear();
    await requestPasswordReset({ email: a.email }, browser());
    await deliver();
    const link = capture.messages.find((m) => m.to === a.email && m.tags?.template === "reset-password")!.text.match(/https?:\/\/\S+/)![0];
    const token = new URL((await auth.handler(new Request(link))).headers.get("location")!, BASE).searchParams.get("token")!;
    await resetPassword({ token, password: NEW_PASSWORD }, browser({ "x-forwarded-for": "203.0.113.44" }));

    const rows = await auditRowsFor(a.userId);
    expect(rows.map((r) => [r.action, r.metadata])).toEqual([
      ["auth.login", { method: "sign-up" }],
      ["auth.password_changed", { via: "reset" }],
    ]);
    expect(rows[1]!.ip).toBe("203.0.113.44");
  });

  it("ending sessions from the account page is not a logout", async () => {
    const a = await newAccount();
    await anotherSession(a.email, SAFARI_IPHONE, "203.0.113.20");
    const [, other] = await listSessions(await must(a.request));
    await revokeSession(other!.handle, a.request);
    await anotherSession(a.email, FIREFOX_WINDOWS, "203.0.113.30");
    await revokeOtherSessions(a.request);
    expect(await actionsOf(a.userId)).toEqual(["auth.login", "auth.login", "auth.login"]);
  });

  it("these rows are invisible to the application in every context, and cannot be changed or deleted by it", async () => {
    const a = await newAccount();
    const org = await createOrganization(a.userId, "Audit Org");
    expect((await auditRowsFor(a.userId)).length).toBeGreaterThan(0);

    const mine = sql`select count(*)::int as n from audit_logs where actor_id = ${a.userId}`;
    expect((await withPlatform((tx) => tx.execute(mine))).rows[0]).toEqual({ n: 0 });
    expect((await withTenant({ orgId: org.id }, (tx) => tx.execute(mine))).rows[0]).toEqual({ n: 0 });

    await expect(withPlatform((tx) => tx.update(auditLogs).set({ action: "tampered" }).where(eq(auditLogs.actorId, a.userId)))).rejects.toThrow();
    await expect(withPlatform((tx) => tx.delete(auditLogs).where(eq(auditLogs.actorId, a.userId)))).rejects.toThrow();
    expect(await actionsOf(a.userId)).toEqual(["auth.login"]);
  });
});
