import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth, SESSION_ABSOLUTE_SECONDS, setAuthForTests } from "@/modules/auth/auth";
import { SESSION_COOKIE, SESSION_IDLE_SECONDS } from "@/modules/auth/cookie";
import { signIn, signUp, startGoogleSignIn, type AuthRequest } from "@/modules/auth/credentials.service";
import { authAccounts, authSessions, authVerifications, users } from "@/modules/auth/schema";
import { assertVerified, resolveAuth, toActor } from "@/modules/auth/session";
import { withPlatform } from "@/platform/db/tenant";
import { emailSend } from "@/platform/email";
import { setEmailProviderForTests } from "@/platform/email/get-provider";
import { CaptureEmailProvider } from "@/platform/email/providers/capture";
import { isAppError } from "@/platform/errors";
import { createJobRegistry, runJobs } from "@/platform/jobs";
import { jobs } from "@/platform/jobs/schema";
import { setLogSink } from "@/platform/observability/logger";

/**
 * M2-3: Google sign-in, sign-up and the account-linking rule, against real
 * Postgres. Everything of Better Auth runs for real: the state row and cookie,
 * PKCE, the callback, the linking decision, the session. The one thing replaced
 * is Google itself: its token endpoint is answered locally with an ID token for
 * whatever profile the test says Google asserts. No Google account, no network.
 */

const BASE = "http://localhost:3000"; // APP_ORIGIN in tests/setup/integration-env.ts
const SECRET = "integration-secret-integration-secret-0123";
const PASSWORD = "correct horse battery staple";
const CLIENT = { clientId: "forge-test.apps.googleusercontent.com", clientSecret: "google-client-secret-for-tests" };
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DAY = 24 * 3600 * 1000;

const auth = createAuth({ baseURL: BASE, secret: SECRET, google: CLIENT });
const capture = new CaptureEmailProvider();
const registry = createJobRegistry([emailSend]);
const logs: string[] = [];

type GoogleProfile = { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
/** What Google will assert at the next token exchange, and how its token endpoint behaves. */
let asserted: GoogleProfile;
let tokenEndpoint: "ok" | "rejects";
const tokenRequests: { body: URLSearchParams; authorization: string | null }[] = [];

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const idToken = (profile: GoogleProfile) =>
  [b64({ alg: "RS256", typ: "JWT", kid: "test" }), b64({ iss: "https://accounts.google.com", aud: CLIENT.clientId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...profile }), b64("signature")].join(".");

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
  tokenRequests.length = 0;
  tokenEndpoint = "ok";
  asserted = { sub: newSub() };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.url !== TOKEN_ENDPOINT) throw new Error(`unexpected outbound request: ${request.url}`);
    tokenRequests.push({ body: new URLSearchParams(await request.text()), authorization: request.headers.get("authorization") });
    if (tokenEndpoint === "rejects") return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({
      access_token: "ya29.google-access-token",
      refresh_token: "1//google-refresh-token",
      id_token: idToken(asserted),
      expires_in: 3599,
      token_type: "Bearer",
      scope: "openid email profile",
    });
  });
});
afterEach(() => vi.unstubAllGlobals());

const newSub = () => `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
const newEmail = () => `google-${uuidv7()}@example.test`;
const identity = <T>(fn: Parameters<typeof withPlatform<T>>[0]) => withPlatform(fn);
const deliver = () => runJobs({ registry, budgetMs: 20_000 });

const browser = (init: Record<string, string> = {}): AuthRequest => ({
  headers: new Headers({ origin: BASE, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "user-agent": "vitest", ...init }),
});
const cookieHeader = (setCookies: string[]) =>
  setCookies
    .map((c) => c.split(";")[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
const sessionOf = (setCookies: string[]) => setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !/Max-Age=0/.test(c));
const whoIs = (cookie: string | undefined) => (cookie ? resolveAuth(new Headers({ cookie: cookie.split(";")[0]! })) : Promise.resolve(null));

/** Step 1: the "Continue with Google" button. */
async function start(next = "/", request = browser()) {
  const started = await startGoogleSignIn({ next }, request);
  const authorize = new URL(started.url);
  return { authorize, state: authorize.searchParams.get("state")!, cookie: cookieHeader(started.setCookies), setCookies: started.setCookies };
}
type Flow = Awaited<ReturnType<typeof start>>;

/** Step 2: Google sends the browser back to our callback. */
async function callback(flow: Pick<Flow, "state" | "cookie">, query: Record<string, string> = { code: "authorization-code" }) {
  const url = new URL(`${BASE}/api/auth/callback/google`);
  for (const [key, value] of Object.entries({ ...query, state: flow.state })) url.searchParams.set(key, value);
  const response = await auth.handler(new Request(url, { headers: flow.cookie ? { cookie: flow.cookie } : {} }));
  const setCookies = response.headers.getSetCookie();
  return { status: response.status, location: response.headers.get("location"), setCookies, session: sessionOf(setCookies) };
}

/** Both steps, with Google asserting `profile`. */
async function signInWithGoogle(profile: GoogleProfile, next = "/") {
  asserted = profile;
  const result = await callback(await start(next));
  return { ...result, auth: await whoIs(result.session) };
}

const userByEmail = async (email: string) => (await identity((tx) => tx.select().from(users).where(eq(users.email, email))))[0];
const accountsOf = (userId: string) => identity((tx) => tx.select().from(authAccounts).where(eq(authAccounts.userId, userId)));
const googleAccountsFor = (sub: string) => identity((tx) => tx.select().from(authAccounts).where(eq(authAccounts.accountId, sub)));

/** A password account, optionally with its address verified. */
async function passwordUser({ verified, email = newEmail() }: { verified: boolean; email?: string }) {
  await signUp({ name: "Password User", email, password: PASSWORD }, browser());
  if (verified) await identity((tx) => tx.update(users).set({ emailVerified: true }).where(eq(users.email, email)));
  return (await userByEmail(email))!;
}

describe("starting the flow", () => {
  it("sends the browser to Google with the authorization-code flow, PKCE, our callback and the default scopes only", async () => {
    const { authorize } = await start("/acme-org/sites");
    expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = authorize.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(CLIENT.clientId);
    expect(q.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/google`);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("scope")!.split(" ").sort()).toEqual(["email", "openid", "profile"]);
    expect(q.get("prompt")).toBe("select_account");
    expect(q.get("access_type")).toBeNull(); // no offline access: no refresh token is asked for
    expect(authorize.toString()).not.toContain(CLIENT.clientSecret);
  });

  it("keeps the state on the server (hashed) and binds it to the browser with a signed, HttpOnly cookie", async () => {
    const { state, setCookies } = await start();
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const rows = await identity((tx) => tx.select().from(authVerifications).where(eq(authVerifications.identifier, state)));
    expect(rows).toEqual([]); // not stored as is
    const hashed = createHash("sha256").update(state).digest("base64url");
    const [row] = await identity((tx) => tx.select().from(authVerifications).where(eq(authVerifications.identifier, hashed)));
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const stateCookie = setCookies.find((c) => c.startsWith("better-auth.state="))!;
    expect(stateCookie).toMatch(/HttpOnly/i);
    expect(stateCookie).toMatch(/SameSite=Lax/i);
    expect(stateCookie).toMatch(/Max-Age=300/);
    expect(stateCookie).not.toMatch(/Domain=/i);
  });

  it("is refused from another origin", async () => {
    const foreign: AuthRequest = { headers: new Headers({ origin: "https://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", cookie: "a=b" }) };
    await expect(startGoogleSignIn({ next: "/" }, foreign)).rejects.toMatchObject({ kind: "Forbidden" });
  });

  it("where Google is not configured there is nothing to start, and passwords work as before", async () => {
    setAuthForTests(createAuth({ baseURL: BASE, secret: SECRET }));
    const error = await startGoogleSignIn({ next: "/" }, browser()).catch((e: unknown) => e);
    expect(isAppError(error) && error.message).toBe("Google sign-in is not available.");
    const email = newEmail();
    await signUp({ name: "No Google", email, password: PASSWORD }, browser());
    await expect(signIn({ email, password: PASSWORD }, browser())).resolves.toBeDefined();
  });
});

describe("a new Google user", () => {
  it("is created with a Google identity, signed in, and verified because Google says the address is", async () => {
    const email = newEmail();
    const sub = newSub();
    const result = await signInWithGoogle({ sub, email, email_verified: true, name: "Grace Google", picture: "https://lh3.example/p.png" }, "/acme-org/sites");

    expect(result.status).toBe(302);
    expect(result.location).toBe("/acme-org/sites");
    expect(result.auth?.user).toMatchObject({ email, name: "Grace Google", emailVerified: true, image: "https://lh3.example/p.png" });
    expect(() => assertVerified(result.auth!.user)).not.toThrow();

    const accounts = await accountsOf(result.auth!.user.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ providerId: "google", accountId: sub, password: null });
    await deliver();
    expect(capture.to(email)).toEqual([]); // already verified: no verification email
  });

  it("with an address Google has NOT verified: created, signed in, but unverified until our own link is followed", async () => {
    const email = newEmail();
    const result = await signInWithGoogle({ sub: newSub(), email, email_verified: false, name: "Unverified" });
    expect(result.auth?.user).toMatchObject({ email, emailVerified: false });
    expect(() => assertVerified(result.auth!.user)).toThrow(expect.objectContaining({ kind: "Forbidden" }));

    await deliver();
    const mail = capture.to(email)[0]!;
    expect(mail.subject).toBe("Verify your email for Forge");
    const link = mail.text.match(/https?:\/\/\S+/)![0];
    const verified = await auth.handler(new Request(link));
    expect(verified.status).toBe(302);
    expect((await whoIs(result.session))?.user.emailVerified).toBe(true);
  });

  it("stores the address lowercased", async () => {
    const mixed = `Mixed.Case-${uuidv7()}@Example.TEST`;
    const result = await signInWithGoogle({ sub: newSub(), email: mixed, email_verified: true, name: "Case" });
    expect(result.auth?.user.email).toBe(mixed.toLowerCase());
  });

  it("without an address from Google nobody is created", async () => {
    const sub = newSub();
    const result = await signInWithGoogle({ sub, name: "No Email" }, "/account");
    expect(result.location).toBe("/login?next=%2Faccount&error=email_not_found");
    expect(result.session).toBeUndefined();
    expect(await googleAccountsFor(sub)).toEqual([]);
  });
});

describe("the session after Google sign-in is an ordinary Forge session", () => {
  it("same cookie, same shape, same lifetime rules as a password login", async () => {
    const email = newEmail();
    const result = await signInWithGoogle({ sub: newSub(), email, email_verified: true, name: "Session" });

    expect(result.session).toMatch(/HttpOnly/i);
    expect(result.session).toMatch(/SameSite=Lax/i);
    expect(result.session).toMatch(new RegExp(`Max-Age=${SESSION_IDLE_SECONDS}`));
    expect(Object.keys(result.auth!.session).sort()).toEqual(["createdAt", "expiresAt", "id"]);
    expect(toActor(result.auth)).toEqual({ kind: "user", userId: result.auth!.user.id, sessionId: result.auth!.session.id, emailVerified: true });
    expect(result.auth).not.toHaveProperty("organizationId");

    const [row] = await identity((tx) => tx.select().from(authSessions).where(eq(authSessions.id, result.auth!.session.id)));
    expect(Math.abs(row!.expiresAt.getTime() - (Date.now() + SESSION_IDLE_SECONDS * 1000))).toBeLessThan(60_000);

    // The 30-day absolute cap applies to it like to any other session.
    await identity((tx) =>
      tx.update(authSessions).set({ createdAt: new Date(Date.now() - SESSION_ABSOLUTE_SECONDS * 1000 - DAY), expiresAt: new Date(Date.now() + DAY) })
        .where(eq(authSessions.id, row!.id)),
    );
    expect(await whoIs(result.session)).toBeNull();
  });

  it("the state cookie is used up, and none of Google's tokens are kept", async () => {
    const email = newEmail();
    const sub = newSub();
    const result = await signInWithGoogle({ sub, email, email_verified: true, name: "Tokens" });
    expect(result.setCookies.find((c) => c.startsWith("better-auth.state="))).toMatch(/Max-Age=0/);

    const [account] = await googleAccountsFor(sub);
    expect(account).toMatchObject({ accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null });
    // A second sign-in does not write them either.
    await signInWithGoogle({ sub, email, email_verified: true, name: "Tokens" });
    const [again] = await googleAccountsFor(sub);
    expect(again).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
    const all = logs.join("\n");
    for (const secret of ["ya29.google-access-token", "1//google-refresh-token", CLIENT.clientSecret]) expect(all).not.toContain(secret);
  });
});

describe("the linking rule: an existing password account and a Google identity with the same address", () => {
  it("both sides verified → linked: the same user, now with two ways in", async () => {
    const user = await passwordUser({ verified: true });
    const sub = newSub();
    const result = await signInWithGoogle({ sub, email: user.email, email_verified: true, name: "Other Name From Google", picture: "https://lh3.example/x.png" });

    expect(result.location).toBe("/");
    expect(result.auth?.user.id).toBe(user.id);
    const accounts = await accountsOf(user.id);
    expect(accounts.map((a) => a.providerId).sort()).toEqual(["credential", "google"]);
    expect(accounts.find((a) => a.providerId === "google")!.accountId).toBe(sub);
    // Linking never rewrites the account from Google's profile.
    expect(await userByEmail(user.email)).toMatchObject({ id: user.id, name: "Password User", image: null, emailVerified: true });
    // The password still works.
    await expect(signIn({ email: user.email, password: PASSWORD }, browser())).resolves.toBeDefined();
    expect(await identity((tx) => tx.select().from(users).where(eq(users.email, user.email)))).toHaveLength(1);
  });

  it("the local address is NOT verified → refused: no link, no session, and Google's word does not verify the account", async () => {
    // The takeover this blocks: register the victim's address with a password, then wait for their first Google sign-in.
    const attackerCreated = await passwordUser({ verified: false });
    const sub = newSub();
    const result = await signInWithGoogle({ sub, email: attackerCreated.email, email_verified: true, name: "The Real Owner" }, "/acme-org/sites");

    expect(result.status).toBe(302);
    expect(result.location).toBe("/login?next=%2Facme-org%2Fsites&error=account_not_linked");
    expect(result.session).toBeUndefined();
    expect(await googleAccountsFor(sub)).toEqual([]);
    expect((await accountsOf(attackerCreated.id)).map((a) => a.providerId)).toEqual(["credential"]);
    expect(await userByEmail(attackerCreated.email)).toMatchObject({ id: attackerCreated.id, emailVerified: false, name: "Password User" });
  });

  it("Google has NOT verified the address → refused, even though the local account is verified", async () => {
    const user = await passwordUser({ verified: true });
    const sub = newSub();
    const result = await signInWithGoogle({ sub, email: user.email, email_verified: false, name: "Claims Only" });
    expect(result.location).toBe("/login?error=account_not_linked");
    expect(result.session).toBeUndefined();
    expect(await googleAccountsFor(sub)).toEqual([]);
  });

  it("the address is compared without regard to case", async () => {
    const user = await passwordUser({ verified: true });
    const result = await signInWithGoogle({ sub: newSub(), email: user.email.toUpperCase(), email_verified: true, name: "Upper" });
    expect(result.auth?.user.id).toBe(user.id);
  });

  it("once the address is verified locally, the same Google sign-in is accepted", async () => {
    const user = await passwordUser({ verified: false });
    const profile = { sub: newSub(), email: user.email, email_verified: true, name: "Owner" };
    expect((await signInWithGoogle(profile)).location).toBe("/login?error=account_not_linked");
    await identity((tx) => tx.update(users).set({ emailVerified: true }).where(eq(users.id, user.id)));
    expect((await signInWithGoogle(profile)).auth?.user.id).toBe(user.id);
  });
});

describe("a Google identity that is already linked", () => {
  it("signs in as the same user every time, without creating anything", async () => {
    const email = newEmail();
    const profile = { sub: newSub(), email, email_verified: true, name: "Returning" };
    const first = await signInWithGoogle(profile);
    const second = await signInWithGoogle(profile);

    expect(second.auth?.user.id).toBe(first.auth!.user.id);
    expect(second.auth?.session.id).not.toBe(first.auth!.session.id); // its own session
    expect(await accountsOf(first.auth!.user.id)).toHaveLength(1);
    expect(await identity((tx) => tx.select().from(users).where(eq(users.email, email)))).toHaveLength(1);
    expect(await whoIs(first.session)).not.toBeNull(); // the earlier session is untouched
  });

  it("is recognised by Google's subject id, not by the address: a changed address still signs in the same user", async () => {
    const original = newEmail();
    const sub = newSub();
    const first = await signInWithGoogle({ sub, email: original, email_verified: true, name: "Mover" });
    const moved = await signInWithGoogle({ sub, email: newEmail(), email_verified: true, name: "Mover Renamed" });

    expect(moved.auth?.user.id).toBe(first.auth!.user.id);
    // Forge's record of the user is not rewritten from Google's profile.
    expect(moved.auth?.user).toMatchObject({ email: original, name: "Mover" });
  });

  it("an account created through Google while unverified becomes verified when Google later verifies the same address", async () => {
    const email = newEmail();
    const sub = newSub();
    const before = await signInWithGoogle({ sub, email, email_verified: false, name: "Late" });
    expect(before.auth?.user.emailVerified).toBe(false);
    const after = await signInWithGoogle({ sub, email, email_verified: true, name: "Late" });
    expect(after.auth?.user).toMatchObject({ id: before.auth!.user.id, emailVerified: true });
    // But only for the address Forge has on record.
    const other = await signInWithGoogle({ sub: newSub(), email: newEmail(), email_verified: false, name: "Other" });
    const moved = await signInWithGoogle({ sub: (await accountsOf(other.auth!.user.id))[0]!.accountId, email: newEmail(), email_verified: true, name: "Other" });
    expect(moved.auth?.user).toMatchObject({ id: other.auth!.user.id, emailVerified: false });
  });
});

describe("a Google identity that belongs to another Forge user", () => {
  it("never reaches a second account: it signs in its owner, even when Google now reports the other user's address", async () => {
    const sub = newSub();
    const owner = await signInWithGoogle({ sub, email: newEmail(), email_verified: true, name: "Owner A" });
    const other = await passwordUser({ verified: true });

    const result = await signInWithGoogle({ sub, email: other.email, email_verified: true, name: "Owner A" });

    expect(result.auth?.user.id).toBe(owner.auth!.user.id); // user A, not B
    expect(result.auth?.user.email).not.toBe(other.email);
    expect((await accountsOf(other.id)).map((a) => a.providerId)).toEqual(["credential"]); // B was not touched
    expect(await googleAccountsFor(sub)).toHaveLength(1); // one identity, one owner
    expect((await googleAccountsFor(sub))[0]!.userId).toBe(owner.auth!.user.id);
  });

  it("cannot be attached by a signed-in user: the link endpoints are not exposed", async () => {
    const other = await passwordUser({ verified: true });
    const { setCookies } = await signIn({ email: other.email, password: PASSWORD }, browser());
    for (const path of ["/link-social", "/unlink-account"]) {
      const response = await auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie: cookieHeader(setCookies) },
          body: JSON.stringify({ provider: "google", providerId: "google", callbackURL: "/" }),
        }),
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("the database refuses a second owner for the same identity", async () => {
    const sub = newSub();
    const owner = await signInWithGoogle({ sub, email: newEmail(), email_verified: true, name: "Owner" });
    const other = await passwordUser({ verified: true });
    await expect(
      identity((tx) => tx.insert(authAccounts).values({ id: uuidv7(), userId: other.id, providerId: "google", accountId: sub })),
    ).rejects.toThrow();
    expect((await googleAccountsFor(sub))[0]!.userId).toBe(owner.auth!.user.id);
  });
});

describe("the callback", () => {
  it("proves possession of the PKCE verifier and authenticates to Google with the client secret", async () => {
    const flow = await start();
    asserted = { sub: newSub(), email: newEmail(), email_verified: true, name: "Pkce" };
    await callback(flow, { code: "the-code-google-issued" });

    expect(tokenRequests).toHaveLength(1);
    const { body, authorization } = tokenRequests[0]!;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code-google-issued");
    expect(body.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/google`);
    const verifier = body.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(flow.authorize.searchParams.get("code_challenge"));
    const viaHeader = authorization ? Buffer.from(authorization.replace(/^Basic /, ""), "base64").toString() : "";
    expect(body.get("client_secret") === CLIENT.clientSecret || viaHeader.endsWith(`:${CLIENT.clientSecret}`)).toBe(true);
  });

  it("a state that was never issued is refused before Google is contacted", async () => {
    const result = await callback({ state: "never-issued-state-never-issued-st", cookie: "" });
    expect(result.status).toBe(302);
    expect(result.location).toBe("/login?error=state_mismatch");
    expect(result.session).toBeUndefined();
    expect(tokenRequests).toHaveLength(0);
  });

  it("a state from another browser is refused (login CSRF): the cookie that started the flow must come back", async () => {
    const victim = await start("/account");
    asserted = { sub: newSub(), email: newEmail(), email_verified: true, name: "Attacker" };
    // The attacker's link carries their own valid state; the victim's browser has no matching cookie.
    const withoutCookie = await callback({ state: victim.state, cookie: "" });
    expect(withoutCookie.location).toBe("/login?next=%2Faccount&error=state_mismatch");
    expect(withoutCookie.session).toBeUndefined();

    const other = await start();
    const wrongCookie = await callback({ state: other.state, cookie: victim.cookie });
    expect(wrongCookie.location).toBe("/login?error=state_mismatch");
    expect(wrongCookie.session).toBeUndefined();
    expect(tokenRequests).toHaveLength(0);
  });

  it("a state works once", async () => {
    const flow = await start();
    asserted = { sub: newSub(), email: newEmail(), email_verified: true, name: "Once" };
    expect((await callback(flow)).session).toBeDefined();
    const replay = await callback(flow);
    expect(replay.location).toBe("/login?error=state_mismatch");
    expect(replay.session).toBeUndefined();
    expect(tokenRequests).toHaveLength(1);
  });

  it("a state older than ten minutes is refused", async () => {
    const flow = await start();
    const hashed = createHash("sha256").update(flow.state).digest("base64url");
    const [row] = await identity((tx) => tx.select().from(authVerifications).where(eq(authVerifications.identifier, hashed)));
    const stored = JSON.parse(row!.value) as { expiresAt: number };
    expect(stored.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    // The same flow, eleven minutes later.
    const aged = JSON.stringify({ ...stored, expiresAt: Date.now() - 60_000 });
    await identity((tx) => tx.update(authVerifications).set({ value: aged }).where(eq(authVerifications.identifier, hashed)));
    const result = await callback(flow);
    expect(result.location).toBe("/login?error=state_mismatch");
    expect(result.session).toBeUndefined();
    expect(tokenRequests).toHaveLength(0);
  });

  it("the user cancelling at Google comes back to the login page, signed out", async () => {
    const flow = await start("/acme-org/sites");
    const result = await callback(flow, { error: "access_denied", error_description: "The user denied the request" });
    expect(result.location).toMatch(/^\/login\?next=%2Facme-org%2Fsites&error=access_denied/);
    expect(result.session).toBeUndefined();
    expect(tokenRequests).toHaveLength(0);
  });

  it("a code Google rejects signs nobody in", async () => {
    tokenEndpoint = "rejects";
    const email = newEmail();
    asserted = { sub: newSub(), email, email_verified: true, name: "Rejected" };
    const result = await callback(await start());
    expect(result.location).toBe("/login?error=invalid_code");
    expect(result.session).toBeUndefined();
    expect(await userByEmail(email)).toBeUndefined();
  });

  it("no code at all signs nobody in", async () => {
    const result = await callback(await start(), {});
    expect(result.location).toBe("/login?error=no_code");
    expect(result.session).toBeUndefined();
  });
});

describe("where a Google sign-in may end", () => {
  it.each([
    ["an admin page", "/acme-org/sites?tab=members", "/acme-org/sites?tab=members"],
    ["another site's URL", "https://evil.example/", "/"],
    ["a protocol-relative URL", "//evil.example", "/"],
    ["a backslash URL", "/\\evil.example", "/"],
    ["a path that normalises to another host", "/.//evil.example", "/"],
    ["a tenant site on this origin", "/s/some-site", "/"],
    ["an API route", "/api/auth/sign-out", "/"],
    ["nothing", "", "/"],
  ])("%s → %s lands on %s", async (_name, next, expected) => {
    asserted = { sub: newSub(), email: newEmail(), email_verified: true, name: "Next" };
    const result = await callback(await start(next));
    expect(result.location).toBe(expected);
    expect(result.session).toBeDefined();
  });

  it("failures go to the login page of this app, keeping only a safe destination", async () => {
    const user = await passwordUser({ verified: false });
    asserted = { sub: newSub(), email: user.email, email_verified: true, name: "x" };
    expect((await callback(await start("https://evil.example/"))).location).toBe("/login?error=account_not_linked");
  });

  it("the HTTP endpoint refuses foreign callback and error URLs outright", async () => {
    for (const body of [{ callbackURL: "https://evil.example/after" }, { callbackURL: "/", errorCallbackURL: "https://evil.example/oops" }]) {
      const response = await auth.handler(
        new Request(`${BASE}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify({ provider: "google", ...body }),
        }),
      );
      expect(response.status).toBe(403);
    }
  });
});
