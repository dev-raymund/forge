import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import { authAccounts, authSessions, authVerifications, users } from "@/modules/auth/schema";
import { withPlatform, withUser } from "@/platform/db/tenant";
import { createSpikeAuth, SESSION_ABSOLUTE_SECONDS, type VerificationMail } from "./auth";

/**
 * Spike S4 / M0-6 (ADR 0004). Everything runs through `auth.handler(Request)`,
 * the same entry point `/api/auth/[...all]` will use, as forge_app through
 * PgBouncer (DATABASE_URL), against Forge's own identity tables.
 */

const BASE = "http://app.localhost:3000";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PASSWORD = "correct horse battery staple";

const outbox: VerificationMail[] = [];
const auth = createSpikeAuth({
  baseURL: BASE,
  secret: "spike-secret-spike-secret-spike-secret-0123",
  sendVerificationEmail: async (mail) => void outbox.push(mail),
  google: { clientId: "spike-google-client-id", clientSecret: "spike-google-client-secret" },
});

type Call = { method?: "GET" | "POST"; body?: unknown; cookie?: string };
async function call(path: string, { method = "POST", body, cookie }: Call = {}, instance = auth, base = BASE) {
  const headers = new Headers({ origin: base });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return instance.handler(
    new Request(`${base}/api/auth${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** "name=value" of the session cookie a response sets. */
function sessionCookie(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => /session_token=[^;]+/.test(c));
  if (!raw) throw new Error(`no session cookie in: ${res.headers.getSetCookie().join(" | ")}`);
  return raw.split(";")[0]!;
}

async function getSession(cookie: string) {
  const res = await call("/get-session", { method: "GET", cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as { user: { id: string; email: string }; session: { id: string } } | null;
}

const newEmail = () => `user-${uuidv7()}@example.com`;
const identity = <T>(fn: Parameters<typeof withPlatform<T>>[0]) => withPlatform(fn);

async function signUp(email = newEmail()) {
  const res = await call("/sign-up/email", { body: { email, password: PASSWORD, name: "Spike User" } });
  expect(res.status).toBe(200);
  const { user } = (await res.json()) as { user: { id: string; email: string } };
  return { res, user, cookie: sessionCookie(res), email: email.toLowerCase() };
}

describe("sign-up", () => {
  let result: Awaited<ReturnType<typeof signUp>>;
  beforeAll(async () => {
    result = await signUp(`Mixed.Case-${uuidv7()}@Example.COM`);
  });

  it("writes to users / auth_accounts / auth_sessions with UUIDv7 ids and a lowercased email", async () => {
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
    // @better-auth/utils: node:crypto scrypt, N=16384 r=16 p=1, 16-byte salt, 64-byte key, "salt:key" hex.
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
    const httpsBase = "https://app.forge.test";
    const httpsAuth = createSpikeAuth({
      baseURL: httpsBase,
      secret: "spike-secret-spike-secret-spike-secret-0123",
      sendVerificationEmail: async () => {},
    });
    const res = await call(
      "/sign-up/email",
      { body: { email: newEmail(), password: PASSWORD, name: "Https" } },
      httpsAuth,
      httpsBase,
    );
    expect(res.status).toBe(200);
    const raw = res.headers.getSetCookie().find((c) => c.includes("session_token="))!;
    expect(raw).toMatch(/^__Secure-/);
    expect(raw).toMatch(/;\s*Secure/i);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    const res = await call("/sign-up/email", { body: { email: newEmail(), password: "short-pass1", name: "x" } });
    expect(res.status).toBe(400);
  });

  it("creates identity only: no organization or membership", async () => {
    // Read in the user's own context, where the membership policies would show
    // their organizations and memberships if sign-up had created any.
    const counts = await withUser(result.user.id, async (tx) => {
      const res = await tx.execute(sql`
        select (select count(*) from organizations)::int as orgs,
               (select count(*) from organization_members)::int as memberships`);
      return res.rows[0];
    });
    expect(counts).toEqual({ orgs: 0, memberships: 0 });
  });
});

describe("email verification", () => {
  it("sends a link on sign-up; following it marks the email verified", async () => {
    const { user, email } = await signUp();
    const mail = outbox.find((m) => m.email === email);
    expect(mail?.url).toContain(`${BASE}/api/auth/verify-email?token=`);

    const res = await call(`/verify-email?token=${encodeURIComponent(mail!.token)}`, { method: "GET" });
    expect(res.status).toBe(200);
    const [row] = await identity((tx) =>
      tx.select({ verified: users.emailVerified }).from(users).where(eq(users.id, user.id)),
    );
    expect(row!.verified).toBe(true);
  });

  it("rejects a tampered token", async () => {
    const { email } = await signUp();
    const mail = outbox.find((m) => m.email === email)!;
    const res = await call(`/verify-email?token=${encodeURIComponent(mail.token.slice(0, -2) + "xx")}`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });
});

describe("login, session retrieval, logout", () => {
  it("logs in with the right password and resolves the session from the cookie", async () => {
    const { user, email } = await signUp();
    const res = await call("/sign-in/email", { body: { email: email.toUpperCase(), password: PASSWORD } });
    expect(res.status).toBe(200);
    const session = await getSession(sessionCookie(res));
    expect(session?.user).toMatchObject({ id: user.id, email });
  });

  it("gives the same generic error for a wrong password and an unknown email", async () => {
    const { email } = await signUp();
    const wrong = await call("/sign-in/email", { body: { email, password: "not the password at all" } });
    const unknown = await call("/sign-in/email", { body: { email: newEmail(), password: PASSWORD } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it("logout deletes the session row and clears the cookie", async () => {
    const { user, cookie } = await signUp();
    const res = await call("/sign-out", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().find((c) => c.includes("session_token="))).toMatch(/Max-Age=0/);
    const rows = await identity((tx) => tx.select().from(authSessions).where(eq(authSessions.userId, user.id)));
    expect(rows).toEqual([]);
    expect(await getSession(cookie)).toBeNull();
  });
});

describe("revocation and lifetime", () => {
  it("a revoked session fails on the very next request; the user's other sessions survive", async () => {
    const { email } = await signUp();
    const first = sessionCookie(await call("/sign-in/email", { body: { email, password: PASSWORD } }));
    const second = sessionCookie(await call("/sign-in/email", { body: { email, password: PASSWORD } }));
    const target = await getSession(first);

    // What "revoke" on /account does: delete the row (here directly, as an admin action would).
    await identity((tx) => tx.delete(authSessions).where(eq(authSessions.id, target!.session.id)));

    expect(await getSession(first)).toBeNull();
    expect(await getSession(second)).not.toBeNull();
  });

  it("slides the idle window, but never past created_at + 30 days", async () => {
    const { user, cookie } = await signUp();
    const createdAt = new Date(Date.now() - 29.5 * 24 * 3600 * 1000);
    const cap = new Date(createdAt.getTime() + SESSION_ABSOLUTE_SECONDS * 1000);
    // Due for refresh (last slid > 1 day ago), with 2 days of idle time left.
    await identity((tx) =>
      tx
        .update(authSessions)
        .set({ createdAt, expiresAt: new Date(Date.now() + 2 * 24 * 3600 * 1000) })
        .where(eq(authSessions.userId, user.id)),
    );

    expect(await getSession(cookie)).not.toBeNull();
    const [row] = await identity((tx) =>
      tx.select({ expiresAt: authSessions.expiresAt }).from(authSessions).where(eq(authSessions.userId, user.id)),
    );
    // Without the cap it would be now + 7 days.
    expect(row!.expiresAt.getTime()).toBe(cap.getTime());
  });

  it("a fresh session slides by the full 7 days", async () => {
    const { user, cookie } = await signUp();
    await identity((tx) =>
      tx
        .update(authSessions)
        .set({ expiresAt: new Date(Date.now() + 5 * 24 * 3600 * 1000) })
        .where(eq(authSessions.userId, user.id)),
    );
    const before = Date.now();
    await getSession(cookie);
    const [row] = await identity((tx) =>
      tx.select({ expiresAt: authSessions.expiresAt }).from(authSessions).where(eq(authSessions.userId, user.id)),
    );
    expect(row!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * 24 * 3600 * 1000 - 1000);
  });
});

describe("Google OAuth readiness", () => {
  it("starts the authorization-code flow with PKCE, state and our callback URL", async () => {
    const res = await call("/sign-in/social", { body: { provider: "google", callbackURL: "/" } });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.origin).toBe("https://accounts.google.com");
    expect(authorize.searchParams.get("client_id")).toBe("spike-google-client-id");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/google`);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "email"]));

    // The state round-trips through our auth_verifications table (UUIDv7 id).
    const state = authorize.searchParams.get("state")!;
    const rows = await identity((tx) =>
      tx.select().from(authVerifications).where(eq(authVerifications.identifier, state)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(UUID_V7);
  });

  it("rejects a callback with an unknown state", async () => {
    const res = await call(`/callback/google?code=fake&state=${uuidv7()}`, { method: "GET" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/error=/);
  });
});
