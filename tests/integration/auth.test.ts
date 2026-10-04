import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth, SESSION_ABSOLUTE_SECONDS, setAuthForTests } from "@/modules/auth/auth";
import { authErrorToAppError } from "@/modules/auth/errors";
import { authAccounts, authSessions, authVerifications, users } from "@/modules/auth/schema";
import { assertAuthenticated, assertVerified, resolveAuth, toActor } from "@/modules/auth/session";
import { resetEnvCache } from "@/platform/config/env";
import { emailSend } from "@/platform/email";
import { setEmailProviderForTests } from "@/platform/email/get-provider";
import { CaptureEmailProvider } from "@/platform/email/providers/capture";
import { withPlatform, withUser } from "@/platform/db/tenant";
import { createJobRegistry, runJobs } from "@/platform/jobs";
import { jobs } from "@/platform/jobs/schema";
import { setLogSink } from "@/platform/observability/logger";
import { createOrganization } from "../fixtures/factories";

/**
 * M2-1: the production Better Auth configuration and Forge's session helpers,
 * against Postgres through PgBouncer as forge_app. Requests go through
 * `auth.handler(Request)`, the entry point of /api/auth/[...all]. Emails are
 * queued as `email.send` jobs and read from the capture provider.
 */

const BASE = "http://localhost:3000"; // APP_ORIGIN in tests/setup/integration-env.ts
const SECRET = "integration-secret-integration-secret-0123";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PASSWORD = "correct horse battery staple";
const DAY = 24 * 3600 * 1000;

const auth = createAuth({ baseURL: BASE, secret: SECRET, google: { clientId: "test-google-client-id", clientSecret: "test-google-secret" } });
const capture = new CaptureEmailProvider();
const registry = createJobRegistry([emailSend]);
const logs: string[] = [];

beforeAll(() => {
  setAuthForTests(auth);
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
beforeEach(() => capture.clear());

type Call = { method?: "GET" | "POST"; body?: unknown; cookie?: string; origin?: string | null };
async function call(path: string, { method = "POST", body, cookie, origin = BASE }: Call = {}, instance = auth, base = BASE) {
  const headers = new Headers();
  if (origin) headers.set("origin", origin === BASE ? base : origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return instance.handler(
    new Request(`${base}/api/auth${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
}

/** "name=value" of the session cookie a response sets. */
function sessionCookie(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => /session_token=[^;]+/.test(c));
  if (!raw) throw new Error(`no session cookie in: ${res.headers.getSetCookie().join(" | ")}`);
  return raw.split(";")[0]!;
}
const withCookie = (cookie: string) => new Headers({ cookie });
const newEmail = () => `user-${uuidv7()}@example.test`;
const identity = <T>(fn: Parameters<typeof withPlatform<T>>[0]) => withPlatform(fn);
const deliver = () => runJobs({ registry, budgetMs: 20_000 });
const linkIn = (text: string) => text.match(/https?:\/\/\S+/)![0];
/** How `auth_verifications.identifier` is stored (`verification.storeIdentifier: "hashed"`). */
const stored = (identifier: string) => createHash("sha256").update(identifier).digest("base64url");
const verificationRows = (identifier: string) =>
  identity((tx) => tx.select().from(authVerifications).where(eq(authVerifications.identifier, identifier)));

async function signUp(email = newEmail()) {
  const res = await call("/sign-up/email", { body: { email, password: PASSWORD, name: "Ada" } });
  expect(res.status).toBe(200);
  const { user } = (await res.json()) as { user: { id: string; email: string } };
  return { res, user, cookie: sessionCookie(res), email: email.toLowerCase() };
}

async function signIn(email: string, password = PASSWORD) {
  const res = await call("/sign-in/email", { body: { email, password } });
  return { res, cookie: res.status === 200 ? sessionCookie(res) : "" };
}

describe("sign-up", () => {
  let result: Awaited<ReturnType<typeof signUp>>;
  beforeAll(async () => {
    result = await signUp(`Mixed.Case-${uuidv7()}@Example.TEST`);
  });

  it("writes users / auth_accounts / auth_sessions with UUIDv7 ids and a lowercased email", async () => {
    const rows = await identity(async (tx) => ({
      user: (await tx.select().from(users).where(eq(users.id, result.user.id)))[0],
      accounts: await tx.select().from(authAccounts).where(eq(authAccounts.userId, result.user.id)),
      sessions: await tx.select().from(authSessions).where(eq(authSessions.userId, result.user.id)),
    }));
    expect(rows.user).toMatchObject({ email: result.email, emailVerified: false });
    expect(rows.user!.id).toMatch(UUID_V7);
    expect(rows.accounts).toHaveLength(1);
    expect(rows.accounts[0]).toMatchObject({ providerId: "credential", accountId: result.user.id });
    expect(rows.accounts[0]!.id).toMatch(UUID_V7);
    expect(rows.sessions).toHaveLength(1);
    expect(rows.sessions[0]!.id).toMatch(UUID_V7);
  });

  it("stores the password only as a salted scrypt hash", async () => {
    const [account] = await identity((tx) =>
      tx.select({ password: authAccounts.password }).from(authAccounts).where(eq(authAccounts.userId, result.user.id)),
    );
    expect(account!.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(account!.password).not.toContain(PASSWORD);
  });

  it("sets a host-only, HttpOnly, SameSite=Lax session cookie with the 7-day idle Max-Age", () => {
    const raw = result.res.headers.getSetCookie().find((c) => c.includes("session_token="))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).toMatch(/Max-Age=604800/);
    expect(raw).not.toMatch(/Domain=/i);
  });

  it("uses a Secure, __Secure- prefixed cookie when the app origin is https", async () => {
    const httpsBase = "https://cms.forgelinetechnologies.com";
    const saved = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = httpsBase; // email links must match the app origin
    resetEnvCache();
    try {
      const httpsAuth = createAuth({ baseURL: httpsBase, secret: SECRET });
      const res = await call("/sign-up/email", { body: { email: newEmail(), password: PASSWORD, name: "Https" } }, httpsAuth, httpsBase);
      expect(res.status).toBe(200);
      const raw = res.headers.getSetCookie().find((c) => c.includes("session_token="))!;
      expect(raw).toMatch(/^__Secure-/);
      expect(raw).toMatch(/;\s*Secure/i);
      expect(raw).toMatch(/HttpOnly/i);
    } finally {
      process.env.APP_ORIGIN = saved;
      resetEnvCache();
    }
  });

  it("rejects passwords shorter than 12 characters", async () => {
    const res = await call("/sign-up/email", { body: { email: newEmail(), password: "short-pass1", name: "x" } });
    expect(res.status).toBe(400);
  });

  it("creates identity only: no organization or membership", async () => {
    const counts = await withUser(result.user.id, async (tx) => {
      const res = await tx.execute(sql`
        select (select count(*) from organizations)::int as orgs,
               (select count(*) from organization_members)::int as memberships`);
      return res.rows[0];
    });
    expect(counts).toEqual({ orgs: 0, memberships: 0 });
  });
});

describe("email verification (through email.send)", () => {
  it("sign-up queues the email; following the delivered link verifies the user", async () => {
    const { user, email, cookie } = await signUp();
    expect(capture.to(email)).toHaveLength(0); // queued in the request, sent by the job
    await deliver();
    const mail = capture.to(email)[0]!;
    expect(mail.subject).toBe("Verify your email for Forge");
    const link = linkIn(mail.text);
    expect(link.startsWith(`${BASE}/api/auth/verify-email?token=`)).toBe(true);

    expect((await resolveAuth(withCookie(cookie)))?.user.emailVerified).toBe(false);
    const res = await call(link.slice(`${BASE}/api/auth`.length), { method: "GET" });
    expect(res.status).toBeLessThan(400);
    const [row] = await identity((tx) => tx.select({ v: users.emailVerified }).from(users).where(eq(users.id, user.id)));
    expect(row!.v).toBe(true);
    expect((await resolveAuth(withCookie(cookie)))?.user.emailVerified).toBe(true); // same session, now verified
  });

  it("rejects a tampered token", async () => {
    const { email } = await signUp();
    await deliver();
    const link = linkIn(capture.to(email)[0]!.text);
    const token = new URL(link).searchParams.get("token")!;
    const res = await call(`/verify-email?token=${encodeURIComponent(token.slice(0, -2) + "xx")}`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe("login and Forge's session helper", () => {
  it("resolves a Forge session from the cookie: only our fields, never the token", async () => {
    const { user, email } = await signUp();
    const { res, cookie } = await signIn(email.toUpperCase());
    expect(res.status).toBe(200);

    const resolved = await resolveAuth(withCookie(cookie));
    expect(resolved).toMatchObject({ user: { id: user.id, email, name: "Ada", emailVerified: false, image: null } });
    expect(Object.keys(resolved!.user).sort()).toEqual(["email", "emailVerified", "id", "image", "name"]);
    expect(Object.keys(resolved!.session).sort()).toEqual(["createdAt", "expiresAt", "id"]);
    expect(resolved!.session.id).toMatch(UUID_V7);
    const token = decodeURIComponent(cookie.split("=")[1]!).split(".")[0]!;
    expect(JSON.stringify(resolved)).not.toContain(token);
    expect(toActor(resolved)).toEqual({ kind: "user", userId: user.id, sessionId: resolved!.session.id, emailVerified: false });
  });

  it("no cookie, a garbage cookie or a forged cookie is anonymous", async () => {
    expect(await resolveAuth(new Headers())).toBeNull();
    expect(await resolveAuth(withCookie("better-auth.session_token=garbage"))).toBeNull();
    const { cookie } = await signUp();
    const [name, value] = cookie.split("=");
    const forged = `${name}=${value!.slice(0, -4)}AAAA`; // signature no longer matches
    expect(await resolveAuth(withCookie(forged))).toBeNull();
    expect(toActor(null)).toEqual({ kind: "anonymous" });
  });

  it("gives the same generic error for a wrong password and an unknown email", async () => {
    const { email } = await signUp();
    const wrong = await call("/sign-in/email", { body: { email, password: "not the password at all" } });
    const unknown = await call("/sign-in/email", { body: { email: newEmail(), password: PASSWORD } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it("each login is its own session", async () => {
    const { email, user } = await signUp();
    const first = await resolveAuth(withCookie((await signIn(email)).cookie));
    const second = await resolveAuth(withCookie((await signIn(email)).cookie));
    expect(first!.session.id).not.toBe(second!.session.id);
    const rows = await identity((tx) => tx.select().from(authSessions).where(eq(authSessions.userId, user.id)));
    expect(rows).toHaveLength(3); // sign-up + two logins, each revocable on its own
  });

  it("logout deletes the session row, clears the cookie, and the session is invalid at once", async () => {
    const { user, cookie } = await signUp();
    expect(await resolveAuth(withCookie(cookie))).not.toBeNull();
    const res = await call("/sign-out", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().find((c) => c.includes("session_token="))).toMatch(/Max-Age=0/);
    expect(await identity((tx) => tx.select().from(authSessions).where(eq(authSessions.userId, user.id)))).toEqual([]);
    expect(await resolveAuth(withCookie(cookie))).toBeNull();
  });
});

describe("session lifetime (enforced on the server)", () => {
  const sessionRow = (userId: string) =>
    identity((tx) => tx.select().from(authSessions).where(eq(authSessions.userId, userId))).then((rows) => rows[0]);
  const setSession = (userId: string, values: Partial<typeof authSessions.$inferInsert>) =>
    identity((tx) => tx.update(authSessions).set(values).where(eq(authSessions.userId, userId)));

  it("a fresh session is valid", async () => {
    const { cookie } = await signUp();
    expect(await resolveAuth(withCookie(cookie))).not.toBeNull();
  });

  it("an idle-expired session is invalid", async () => {
    const { user, cookie } = await signUp();
    await setSession(user.id, { expiresAt: new Date(Date.now() - 1_000) });
    expect(await resolveAuth(withCookie(cookie))).toBeNull();
  });

  it("a session older than 30 days is invalid even if it has not idle-expired, and is deleted", async () => {
    const { user, cookie } = await signUp();
    await setSession(user.id, { createdAt: new Date(Date.now() - 31 * DAY), expiresAt: new Date(Date.now() + 6.5 * DAY) });
    expect(await resolveAuth(withCookie(cookie))).toBeNull();
    expect(await sessionRow(user.id)).toBeUndefined();
  });

  it("a revoked session fails on the very next request; the user's other sessions survive", async () => {
    const { email } = await signUp();
    const first = (await signIn(email)).cookie;
    const second = (await signIn(email)).cookie;
    const target = await resolveAuth(withCookie(first));
    await identity((tx) => tx.delete(authSessions).where(eq(authSessions.id, target!.session.id)));
    expect(await resolveAuth(withCookie(first))).toBeNull();
    expect(await resolveAuth(withCookie(second))).not.toBeNull();
  });

  it("slides the idle window, but never past created_at + 30 days", async () => {
    const { user, cookie } = await signUp();
    const createdAt = new Date(Date.now() - 29.5 * DAY);
    const cap = new Date(createdAt.getTime() + SESSION_ABSOLUTE_SECONDS * 1000);
    await setSession(user.id, { createdAt, expiresAt: new Date(Date.now() + 2 * DAY) }); // due for a refresh
    expect(await resolveAuth(withCookie(cookie))).not.toBeNull();
    expect((await sessionRow(user.id))!.expiresAt.getTime()).toBe(cap.getTime()); // without the cap: now + 7 days
  });

  it("a recently created session slides by the full 7 days", async () => {
    const { user, cookie } = await signUp();
    await setSession(user.id, { expiresAt: new Date(Date.now() + 5 * DAY) });
    const before = Date.now();
    await resolveAuth(withCookie(cookie));
    expect((await sessionRow(user.id))!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY - 1_000);
  });
});

describe("password reset (through email.send)", () => {
  async function requestReset(email: string) {
    const res = await call("/request-password-reset", { body: { email, redirectTo: "/reset-password" } });
    await deliver();
    return res;
  }
  const resetToken = (email: string) => {
    const mail = capture.messages.find((m) => m.to === email && m.tags?.template === "reset-password")!;
    return new URL(linkIn(mail.text)).pathname.split("/").pop()!;
  };

  it("the delivered token sets a new password, signs out every session, and works once", async () => {
    const { email, cookie } = await signUp();
    const other = (await signIn(email)).cookie;
    capture.clear();
    expect((await requestReset(email)).status).toBe(200);
    const token = resetToken(email);

    expect((await call("/reset-password", { body: { token, newPassword: "a brand new passphrase" } })).status).toBe(200);
    expect((await signIn(email, "a brand new passphrase")).res.status).toBe(200);
    expect((await signIn(email)).res.status).toBe(401); // old password
    expect(await resolveAuth(withCookie(cookie))).toBeNull(); // sessions from before the reset are revoked
    expect(await resolveAuth(withCookie(other))).toBeNull();
    expect((await call("/reset-password", { body: { token, newPassword: "yet another passphrase" } })).status).toBe(400); // single use
  });

  it("an expired token is rejected", async () => {
    const { email } = await signUp();
    capture.clear();
    await requestReset(email);
    const token = resetToken(email);
    const expired = await identity((tx) =>
      tx.update(authVerifications).set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(authVerifications.identifier, stored(`reset-password:${token}`))).returning({ id: authVerifications.id }),
    );
    expect(expired).toHaveLength(1);
    expect((await call("/reset-password", { body: { token, newPassword: "a brand new passphrase" } })).status).toBe(400);
    expect((await signIn(email)).res.status).toBe(200); // the password is unchanged
  });

  it("an unknown address gets the same response and no email", async () => {
    const known = await signUp();
    capture.clear();
    const a = await requestReset(known.email);
    const b = await requestReset(newEmail());
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json()).toEqual(await b.json());
    expect(capture.messages.filter((m) => m.tags?.template === "reset-password").map((m) => m.to)).toEqual([known.email]);
  });

  it("the token is stored only as a hash", async () => {
    const { email, user } = await signUp();
    capture.clear();
    await requestReset(email);
    const token = resetToken(email);
    expect(await verificationRows(`reset-password:${token}`)).toEqual([]);
    const rows = await verificationRows(stored(`reset-password:${token}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: user.id });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  it("tokens and addresses never reach the logs", async () => {
    logs.length = 0;
    const { email } = await signUp();
    capture.clear();
    await requestReset(email);
    const token = resetToken(email);
    expect(logs.join("\n")).not.toContain(token);
    expect(logs.join("\n")).not.toContain(email);
  });
});

describe("request safety", () => {
  it("rejects a state-changing request from another origin (CSRF)", async () => {
    const { cookie } = await signUp();
    const res = await call("/sign-out", { cookie, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await resolveAuth(withCookie(cookie))).not.toBeNull(); // still signed in
  });

  it("refuses redirects to other origins (open redirect)", async () => {
    const { email } = await signUp();
    const reset = await call("/request-password-reset", { body: { email, redirectTo: "https://evil.example/steal" } });
    expect(reset.status).toBe(403);
    const social = await call("/sign-in/social", { body: { provider: "google", callbackURL: "https://evil.example/after" } });
    expect(social.status).toBe(403);
  });

  it("does not expose endpoints V1 doesn't use", async () => {
    const { cookie } = await signUp();
    for (const path of ["/change-email", "/delete-user", "/link-social", "/unlink-account"]) {
      expect((await call(path, { cookie, body: {} })).status, path).toBe(404);
    }
  });
});

describe("Google OAuth", () => {
  it("is optional: without Google credentials, email/password works and the Google route is unavailable", async () => {
    const plain = createAuth({ baseURL: BASE, secret: SECRET });
    const email = newEmail();
    expect((await call("/sign-up/email", { body: { email, password: PASSWORD, name: "No Google" } }, plain)).status).toBe(200);
    expect((await call("/sign-in/email", { body: { email, password: PASSWORD } }, plain)).status).toBe(200);
    expect((await call("/sign-in/social", { body: { provider: "google", callbackURL: "/" } }, plain)).status).toBe(404);
  });

  it("when configured, starts the authorization-code flow with PKCE, state and our callback URL", async () => {
    const res = await call("/sign-in/social", { body: { provider: "google", callbackURL: "/" } });
    expect(res.status).toBe(200);
    const authorize = new URL(((await res.json()) as { url: string }).url);
    expect(authorize.origin).toBe("https://accounts.google.com");
    expect(authorize.searchParams.get("client_id")).toBe("test-google-client-id");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/google`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorize.searchParams.get("state")!;
    expect(await verificationRows(stored(state))).toHaveLength(1); // state is kept server-side, hashed
    expect(await verificationRows(state)).toEqual([]);
  });

  it("rejects a callback with an unknown state", async () => {
    const res = await call(`/callback/google?code=fake&state=${uuidv7()}`, { method: "GET" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/error=/);
  });
});

describe("authentication is not authorization", () => {
  it("a session identifies the user; it reveals only the organizations the user belongs to", async () => {
    const a = await signUp();
    const b = await signUp();
    const orgA = await createOrganization(a.user.id, "Org of A");
    const orgB = await createOrganization(b.user.id, "Org of B");

    const asA = await resolveAuth(withCookie(a.cookie));
    expect(asA).not.toHaveProperty("organizationId"); // no organization in a session (D-08)
    const visible = await withUser(asA!.user.id, (tx) => tx.execute<{ id: string }>(sql`select id from organizations`));
    expect(visible.rows.map((r) => r.id)).toEqual([orgA.id]);
    expect(visible.rows.map((r) => r.id)).not.toContain(orgB.id);
    const memberships = await withUser(asA!.user.id, (tx) => tx.execute<{ organization_id: string }>(sql`select organization_id from organization_members`));
    expect(memberships.rows.map((r) => r.organization_id)).toEqual([orgA.id]);
  });

  it("requireUser-style guards: anonymous → Unauthenticated, unverified → Forbidden, verified → the user", async () => {
    expect(() => assertAuthenticated(null)).toThrow(expect.objectContaining({ kind: "Unauthenticated" }));
    const { email, cookie } = await signUp();
    const resolved = assertAuthenticated(await resolveAuth(withCookie(cookie)));
    expect(() => assertVerified(resolved.user)).toThrow(expect.objectContaining({ kind: "Forbidden" }));
    await identity((tx) => tx.update(users).set({ emailVerified: true }).where(eq(users.email, email)));
    expect(assertVerified((await resolveAuth(withCookie(cookie)))!.user).email).toBe(email);
  });
});

describe("Better Auth errors become Forge errors", () => {
  const mapped = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (e) {
      return authErrorToAppError(e);
    }
    throw new Error("expected the call to fail");
  };

  it("maps real failures without exposing which part was wrong", async () => {
    const { email } = await signUp();
    const wrongPassword = await mapped(() => auth.api.signInEmail({ body: { email, password: "nope nope nope nope" } }));
    const unknownEmail = await mapped(() => auth.api.signInEmail({ body: { email: newEmail(), password: PASSWORD } }));
    expect(wrongPassword).toMatchObject({ kind: "Validation", fieldErrors: { _form: ["Email or password is incorrect."] } });
    expect(unknownEmail).toMatchObject({ kind: wrongPassword!.kind, fieldErrors: wrongPassword!.fieldErrors });

    expect(await mapped(() => auth.api.signUpEmail({ body: { email: newEmail(), password: "short", name: "x" } }))).toMatchObject({
      kind: "Validation",
      fieldErrors: { password: ["Use at least 12 characters."] },
    });
    expect(await mapped(() => auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "x" } }))).toMatchObject({
      kind: "Validation",
      fieldErrors: { email: ["An account with this email already exists."] },
    });
    expect(await mapped(() => auth.api.resetPassword({ body: { token: "not-a-token", newPassword: "a brand new passphrase" } }))).toMatchObject({
      kind: "Validation",
      fieldErrors: { _form: ["This link is invalid or has expired. Request a new one."] },
    });
  });
});
