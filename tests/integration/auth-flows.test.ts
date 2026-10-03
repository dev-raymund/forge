import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth, setAuthForTests } from "@/modules/auth/auth";
import { renewedSessionCookie, SECURE_SESSION_COOKIE, SESSION_COOKIE, findSessionCookie } from "@/modules/auth/cookie";
import {
  requestPasswordReset, resendVerificationEmail, resetPassword, signIn, signOut, signUp, UnexpectedAuthError,
  type AuthRequest,
} from "@/modules/auth/credentials.service";
import { authAccounts, authSessions, users } from "@/modules/auth/schema";
import { resolveAuth } from "@/modules/auth/session";
import { resetEnvCache } from "@/platform/config/env";
import { withPlatform } from "@/platform/db/tenant";
import { emailSend } from "@/platform/email";
import { setEmailProviderForTests } from "@/platform/email/get-provider";
import { CaptureEmailProvider } from "@/platform/email/providers/capture";
import { isAppError } from "@/platform/errors";
import { createJobRegistry, runJobs } from "@/platform/jobs";
import { setLogSink } from "@/platform/observability/logger";
import { safeNextPath } from "@/platform/routing/admin-access";

/**
 * M2-2: the account use cases behind the auth forms, against real Postgres.
 * These are the functions the Server Actions call; like the forms, they go
 * through Better Auth's request handler, so its rate limiter, origin checks and
 * captcha apply. Emails are queued as `email.send` jobs and read from the
 * capture provider.
 */

const BASE = "http://localhost:3000"; // APP_ORIGIN in tests/setup/integration-env.ts
const SECRET = "integration-secret-integration-secret-0123";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "an entirely new passphrase";

const auth = createAuth({ baseURL: BASE, secret: SECRET });
const capture = new CaptureEmailProvider();
const registry = createJobRegistry([emailSend]);
const logs: string[] = [];

beforeAll(() => {
  setEmailProviderForTests(capture);
  setLogSink((_level, line) => logs.push(line));
});
afterAll(() => {
  setAuthForTests(null);
  setEmailProviderForTests(null);
  setLogSink(null);
});
beforeEach(() => {
  setAuthForTests(auth);
  capture.clear();
  logs.length = 0;
});

const newEmail = () => `flow-${uuidv7()}@example.test`;
const deliver = () => runJobs({ registry, budgetMs: 20_000 });
const linkIn = (text: string) => text.match(/https?:\/\/\S+/)![0];
const identity = <T>(fn: Parameters<typeof withPlatform<T>>[0]) => withPlatform(fn);

/** What a browser on the app would send with a form post. */
const browser = (init: Record<string, string> = {}): AuthRequest => ({
  headers: new Headers({ origin: BASE, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "user-agent": "vitest", ...init }),
});
/** The `Cookie` header a browser would send after receiving these `Set-Cookie` values. */
const cookieHeader = (setCookies: string[]) =>
  setCookies
    .map((c) => c.split(";")[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
const signedIn = (setCookies: string[]) => browser({ cookie: cookieHeader(setCookies) });
const whoIs = (request: AuthRequest) => resolveAuth(request.headers);

async function newAccount(email = newEmail(), name = "Ada Flow") {
  const { setCookies } = await signUp({ name, email, password: PASSWORD }, browser());
  return { email, setCookies, request: signedIn(setCookies) };
}

/** The AppError a use case throws, or a failure if it throws anything else or nothing. */
async function failureOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error("expected the use case to fail");
}

describe("sign up", () => {
  it("creates the account, signs the user in (unverified), and queues the verification email", async () => {
    const { email, setCookies, request } = await newAccount();
    expect(setCookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    const session = await whoIs(request);
    expect(session?.user).toMatchObject({ email, name: "Ada Flow", emailVerified: false });

    await deliver();
    const mail = capture.to(email)[0]!;
    expect(mail.subject).toBe("Verify your email for Forge");
    // The link returns to the verify-email screen, on this app.
    const link = new URL(linkIn(mail.text));
    expect(link.origin).toBe(BASE);
    expect(link.pathname).toBe("/api/auth/verify-email");
    expect(link.searchParams.get("callbackURL")).toBe("/verify-email?status=verified");
  });

  it("stores the address lowercased, whatever was typed", async () => {
    const mixed = `Mixed.Case-${uuidv7()}@Example.TEST`;
    const { request } = await newAccount(mixed);
    expect((await whoIs(request))?.user.email).toBe(mixed.toLowerCase());
  });

  it("an address that already has an account: a field error, no second account, no session", async () => {
    const { email } = await newAccount();
    const error = await failureOf(() => signUp({ name: "Someone Else", email, password: PASSWORD }, browser()));
    expect(error).toMatchObject({ kind: "Validation", fieldErrors: { email: ["An account with this email already exists."] } });
    const rows = await identity((tx) => tx.select().from(users).where(eq(users.email, email)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ada Flow"); // untouched
    // Also when the casing differs.
    const again = await failureOf(() => signUp({ name: "x", email: email.toUpperCase(), password: PASSWORD }, browser()));
    expect(again.fieldErrors).toEqual({ email: ["An account with this email already exists."] });
  });

  it("Better Auth enforces the same password bounds as the form's schema", async () => {
    const short = await failureOf(() => signUp({ name: "x", email: newEmail(), password: "elevenchars" }, browser()));
    expect(short.fieldErrors).toEqual({ password: ["Use at least 12 characters."] });
    const long = await failureOf(() => signUp({ name: "x", email: newEmail(), password: "x".repeat(129) }, browser()));
    expect(long.fieldErrors).toEqual({ password: ["Use at most 128 characters."] });
  });
});

describe("log in and the protected session", () => {
  it("the right password signs in; the session resolves to the user", async () => {
    const { email } = await newAccount();
    const { setCookies } = await signIn({ email, password: PASSWORD }, browser());
    expect((await whoIs(signedIn(setCookies)))?.user.email).toBe(email);
  });

  it("a wrong password and an unknown address fail identically, and sign nobody in", async () => {
    const { email } = await newAccount();
    const wrong = await failureOf(() => signIn({ email, password: "not the password at all" }, browser()));
    const unknown = await failureOf(() => signIn({ email: newEmail(), password: PASSWORD }, browser()));
    for (const error of [wrong, unknown]) {
      expect(error).toMatchObject({ kind: "Validation", message: "Email or password is incorrect.", fieldErrors: { _form: ["Email or password is incorrect."] } });
    }
    expect({ ...wrong, stack: "" }).toEqual({ ...unknown, stack: "" });
  });

  it("without a cookie, with a garbage cookie, or with a forged signature there is no session", async () => {
    const { setCookies } = await newAccount();
    expect(await whoIs(browser())).toBeNull();
    expect(await whoIs(browser({ cookie: `${SESSION_COOKIE}=garbage` }))).toBeNull();
    const real = cookieHeader(setCookies);
    expect(await whoIs(browser({ cookie: `${real.slice(0, -6)}AAAAAA` }))).toBeNull();
    expect(await whoIs(browser({ cookie: real }))).not.toBeNull();
  });

  it("an expired session is no session", async () => {
    const { email, request } = await newAccount();
    expect(await whoIs(request)).not.toBeNull();
    const [user] = await identity((tx) => tx.select({ id: users.id }).from(users).where(eq(users.email, email)));
    await identity((tx) => tx.update(authSessions).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(authSessions.userId, user!.id)));
    expect(await whoIs(request)).toBeNull();
    // 31 days old, even if it has not idle-expired.
    const again = signedIn((await signIn({ email, password: PASSWORD }, browser())).setCookies);
    await identity((tx) =>
      tx.update(authSessions).set({ createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000), expiresAt: new Date(Date.now() + 3600 * 1000) })
        .where(eq(authSessions.userId, user!.id)),
    );
    expect(await whoIs(again)).toBeNull();
  });
});

describe("log out", () => {
  it("deletes the session and returns the cookie that clears the browser's; other sessions survive", async () => {
    const { email, request } = await newAccount();
    const other = signedIn((await signIn({ email, password: PASSWORD }, browser())).setCookies);

    const { setCookies } = await signOut(request);
    expect(setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toMatch(/Max-Age=0/);
    expect(await whoIs(request)).toBeNull(); // the old cookie no longer works
    expect(await whoIs(other)).not.toBeNull();
  });

  it("is safe without a session: it still answers with the clearing cookie", async () => {
    const { setCookies } = await signOut(browser());
    expect(setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toMatch(/Max-Age=0/);
  });
});

describe("email verification", () => {
  it("following the emailed link verifies the address; the same session then reads verified", async () => {
    const { email, request } = await newAccount();
    await deliver();
    const link = linkIn(capture.to(email)[0]!.text);
    const response = await auth.handler(new Request(link, { headers: request.headers }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/verify-email?status=verified");
    expect((await whoIs(request))?.user.emailVerified).toBe(true);
  });

  it("a tampered or expired link lands on the verify screen with an error, and verifies nothing", async () => {
    const { email, request } = await newAccount();
    await deliver();
    const link = new URL(linkIn(capture.to(email)[0]!.text));
    link.searchParams.set("token", `${link.searchParams.get("token")!.slice(0, -3)}abc`);
    const response = await auth.handler(new Request(link, { headers: request.headers }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/verify-email?status=verified&error=INVALID_TOKEN");
    expect((await whoIs(request))?.user.emailVerified).toBe(false);
  });

  it("resend goes to the signed-in user's own address, and only while unverified", async () => {
    const { email, request } = await newAccount();
    await deliver();
    capture.clear();
    const user = (await whoIs(request))!.user;
    expect(await resendVerificationEmail(user, request)).toEqual({ alreadyVerified: false });
    await deliver();
    expect(capture.messages.map((m) => m.to)).toEqual([email]);
    expect(new URL(linkIn(capture.to(email)[0]!.text)).searchParams.get("callbackURL")).toBe("/verify-email?status=verified");

    // Verified in the meantime: nothing is sent.
    await identity((tx) => tx.update(users).set({ emailVerified: true }).where(eq(users.email, email)));
    capture.clear();
    expect(await resendVerificationEmail({ ...user, emailVerified: true }, request)).toEqual({ alreadyVerified: true });
    expect(await resendVerificationEmail(user, request)).toEqual({ alreadyVerified: true }); // a stale view of the user
    await deliver();
    expect(capture.messages).toEqual([]);
  });

  it("resend cannot be pointed at another account's address", async () => {
    const victim = await newAccount();
    const attacker = await newAccount();
    await deliver();
    capture.clear();
    const attackerUser = (await whoIs(attacker.request))!.user;
    const error = await failureOf(() => resendVerificationEmail({ ...attackerUser, email: victim.email }, attacker.request));
    expect(error.kind).toBe("Forbidden");
    await deliver();
    expect(capture.to(victim.email)).toEqual([]);
  });
});

describe("password reset", () => {
  const resetLink = (email: string) => linkIn(capture.messages.find((m) => m.to === email && m.tags?.template === "reset-password")!.text);

  /** Follows the emailed link the way a browser does; returns where it lands. */
  async function followResetLink(email: string) {
    const response = await auth.handler(new Request(resetLink(email)));
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location")!, BASE);
  }

  it("request → email → link → new password → log in; old password and old sessions are gone", async () => {
    const { email, request } = await newAccount();
    const second = signedIn((await signIn({ email, password: PASSWORD }, browser())).setCookies);
    capture.clear();

    await requestPasswordReset({ email }, browser());
    await deliver();
    const landing = await followResetLink(email);
    expect(landing.origin).toBe(BASE);
    expect(landing.pathname).toBe("/reset-password");
    const token = landing.searchParams.get("token")!;

    await resetPassword({ token, password: NEW_PASSWORD }, browser());
    expect(await whoIs(request)).toBeNull(); // every session from before the reset
    expect(await whoIs(second)).toBeNull();
    expect((await failureOf(() => signIn({ email, password: PASSWORD }, browser()))).message).toBe("Email or password is incorrect.");
    const { setCookies } = await signIn({ email, password: NEW_PASSWORD }, browser());
    expect((await whoIs(signedIn(setCookies)))?.user.email).toBe(email);

    // The link works once: the token is refused, and the link itself now reports an error.
    const reuse = await failureOf(() => resetPassword({ token, password: "yet another passphrase" }, browser()));
    expect(reuse.message).toBe("This link is invalid or has expired. Request a new one.");
    expect((await followResetLink(email)).searchParams.get("error")).toBe("INVALID_TOKEN");
  });

  it("known and unknown addresses are indistinguishable to the caller; only the known one gets an email", async () => {
    const { email } = await newAccount();
    capture.clear();
    const unknown = newEmail();
    await expect(requestPasswordReset({ email }, browser())).resolves.toBeUndefined();
    await expect(requestPasswordReset({ email: unknown }, browser())).resolves.toBeUndefined();
    await deliver();
    expect(capture.messages.filter((m) => m.tags?.template === "reset-password").map((m) => m.to)).toEqual([email]);
    const created = await identity((tx) => tx.select().from(users).where(eq(users.email, unknown)));
    expect(created).toEqual([]); // asking about an address never creates anything
  });

  it("a made-up or malformed token is refused with the same message", async () => {
    for (const token of ["not-a-token", uuidv7(), "x".repeat(200)]) {
      const error = await failureOf(() => resetPassword({ token, password: NEW_PASSWORD }, browser()));
      expect(error).toMatchObject({ kind: "Validation", message: "This link is invalid or has expired. Request a new one." });
    }
  });

  it("the new password must meet the rules; a refused attempt does not use up the link", async () => {
    const { email } = await newAccount();
    capture.clear();
    await requestPasswordReset({ email }, browser());
    await deliver();
    const token = (await followResetLink(email)).searchParams.get("token")!;
    const short = await failureOf(() => resetPassword({ token, password: "short" }, browser()));
    expect(short.fieldErrors).toEqual({ password: ["Use at least 12 characters."] });
    await expect(resetPassword({ token, password: NEW_PASSWORD }, browser())).resolves.toBeUndefined();
  });

  it("passwords, tokens and addresses never reach the logs", async () => {
    const { email } = await newAccount();
    capture.clear();
    await requestPasswordReset({ email }, browser());
    await deliver();
    const token = (await followResetLink(email)).searchParams.get("token")!;
    await failureOf(() => signIn({ email, password: "a wrong secret passphrase" }, browser()));
    await resetPassword({ token, password: NEW_PASSWORD }, browser());
    const all = logs.join("\n");
    for (const secret of [PASSWORD, NEW_PASSWORD, "a wrong secret passphrase", token, email]) expect(all).not.toContain(secret);
    const [account] = await identity((tx) =>
      tx.select({ password: authAccounts.password }).from(authAccounts).innerJoin(users, eq(users.id, authAccounts.userId)).where(eq(users.email, email)),
    );
    expect(account!.password).not.toContain(NEW_PASSWORD);
  });
});

describe("the forms are held to the same rules as the HTTP API", () => {
  it("a request from another origin is refused, with or without a session", async () => {
    const { email, setCookies } = await newAccount();
    const foreign = (cookie?: string): AuthRequest => ({
      headers: new Headers({ origin: "https://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", ...(cookie ? { cookie } : {}) }),
    });
    const WRONG_ORIGIN = "This request didn't come from the Forge app. Reload the page and try again.";

    expect(await failureOf(() => signIn({ email, password: PASSWORD }, foreign()))).toMatchObject({ kind: "Forbidden", message: WRONG_ORIGIN });
    expect(await failureOf(() => signUp({ name: "x", email: newEmail(), password: PASSWORD }, foreign()))).toMatchObject({ kind: "Forbidden" });
    expect(await failureOf(() => signOut(foreign(cookieHeader(setCookies))))).toMatchObject({ kind: "Forbidden", message: WRONG_ORIGIN });
    expect(await whoIs(signedIn(setCookies))).not.toBeNull(); // still signed in
  });

  it("a cross-site form post that navigates (login CSRF) is refused", async () => {
    const { email } = await newAccount();
    const navigation: AuthRequest = { headers: new Headers({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }) };
    expect(await failureOf(() => signIn({ email, password: PASSWORD }, navigation))).toMatchObject({ kind: "Forbidden" });
  });

  it("only the listed headers reach Better Auth: the session, the origin and the client address", async () => {
    const seen: string[][] = [];
    const real = auth.handler;
    const spy = vi.spyOn(auth, "handler").mockImplementation((request: Request) => {
      seen.push([...request.headers.keys()]);
      return real(request);
    });
    try {
      await failureOf(() =>
        signIn({ email: newEmail(), password: PASSWORD }, browser({ authorization: "Bearer fk_live_secret", "x-forwarded-for": "203.0.113.9", "x-api-key": "k", cookie: "a=b" })),
      );
    } finally {
      spy.mockRestore();
    }
    expect(seen[0]!.sort()).toEqual(["content-type", "cookie", "origin", "sec-fetch-mode", "sec-fetch-site", "user-agent", "x-forwarded-for"]);
  });

  describe("rate limiting", () => {
    const limited = createAuth({ baseURL: BASE, secret: SECRET, rateLimit: true });
    beforeEach(() => setAuthForTests(limited));
    const from = (ip: string) => browser({ "x-forwarded-for": ip });

    it("the fourth login attempt within ten seconds from one address is refused; another address is not affected", async () => {
      const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
      const email = newEmail();
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect((await failureOf(() => signIn({ email, password: "wrong wrong wrong" }, from(ip)))).message).toBe("Email or password is incorrect.");
      }
      const fourth = await failureOf(() => signIn({ email, password: "wrong wrong wrong" }, from(ip)));
      expect(fourth).toMatchObject({ kind: "RateLimited", message: "Too many requests. Please try again shortly." });
      expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
      expect((await failureOf(() => signIn({ email, password: "wrong wrong wrong" }, from("203.0.113.77")))).kind).toBe("Validation");
    });

    it("reset emails are limited too (3 per minute), without saying anything about the address", async () => {
      const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
      for (let attempt = 1; attempt <= 3; attempt++) await requestPasswordReset({ email: newEmail() }, from(ip));
      expect(await failureOf(() => requestPasswordReset({ email: newEmail() }, from(ip)))).toMatchObject({ kind: "RateLimited" });
    });
  });

  describe("Turnstile on sign-up", () => {
    const guarded = createAuth({ baseURL: BASE, secret: SECRET, turnstileSecretKey: "turnstile-secret" });
    let verdict: { success: boolean } | "down" = { success: true };
    const calls: { url: string; body: Record<string, unknown> }[] = [];

    beforeEach(() => {
      setAuthForTests(guarded);
      verdict = { success: true };
      calls.length = 0;
      // Cloudflare's siteverify endpoint is the only outbound call; nothing leaves the machine.
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) throw new Error(`unexpected outbound request: ${url}`);
        const raw = input instanceof Request ? await input.text() : String(init?.body ?? "{}");
        calls.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
        if (verdict === "down") return new Response("upstream error", { status: 502 });
        return Response.json(verdict);
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    const account = () => ({ name: "Captcha", email: newEmail(), password: PASSWORD });
    const CHECK = "Complete the security check and try again.";

    it("a verified token creates the account; the secret and the token go to Cloudflare, nowhere else", async () => {
      const { setCookies } = await signUp(account(), { ...browser({ "x-forwarded-for": "203.0.113.5" }), captchaToken: "token-from-widget" });
      expect(await whoIs(signedIn(setCookies))).not.toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toMatchObject({ secret: "turnstile-secret", response: "token-from-widget", remoteip: "203.0.113.5" });
      expect(logs.join("\n")).not.toContain("turnstile-secret");
    });

    it("no token: refused before Cloudflare is even asked, and no account is created", async () => {
      const input = account();
      expect(await failureOf(() => signUp(input, browser()))).toMatchObject({ kind: "Validation", message: CHECK });
      expect(calls).toHaveLength(0);
      expect(await identity((tx) => tx.select().from(users).where(eq(users.email, input.email)))).toEqual([]);
    });

    it("a token Cloudflare rejects: refused, no account", async () => {
      verdict = { success: false };
      const input = account();
      expect(await failureOf(() => signUp(input, { ...browser(), captchaToken: "replayed-token" }))).toMatchObject({ kind: "Validation", message: CHECK });
      expect(await identity((tx) => tx.select().from(users).where(eq(users.email, input.email)))).toEqual([]);
    });

    it("Cloudflare unreachable: sign-up fails closed as an unexpected error, never open", async () => {
      verdict = "down";
      const input = account();
      await expect(signUp(input, { ...browser(), captchaToken: "token" })).rejects.toBeInstanceOf(UnexpectedAuthError);
      expect(await identity((tx) => tx.select().from(users).where(eq(users.email, input.email)))).toEqual([]);
    });

    it("the HTTP endpoint is covered by the same check; logging in is not challenged", async () => {
      const direct = await guarded.handler(
        new Request(`${BASE}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify(account()),
        }),
      );
      expect(direct.status).toBe(400);
      expect(((await direct.json()) as { code: string }).code).toBe("MISSING_RESPONSE");

      const { email } = await (async () => {
        const input = account();
        await signUp(input, { ...browser(), captchaToken: "ok" });
        return input;
      })();
      calls.length = 0;
      await expect(signIn({ email, password: PASSWORD }, browser())).resolves.toBeDefined();
      expect(calls).toHaveLength(0);
    });
  });
});

describe("the session cookie, as the proxy knows it", () => {
  const attributes = (setCookie: string) =>
    Object.fromEntries(setCookie.split(";").slice(1).map((part) => part.trim().split("=")).map(([k, v]) => [k!.toLowerCase(), v ?? true]));

  it("the proxy's renewal has exactly the name and attributes Better Auth sets (http)", async () => {
    const { setCookies } = await newAccount();
    const issued = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    const found = findSessionCookie(cookieHeader(setCookies))!;
    expect(found.name).toBe(SESSION_COOKIE);
    const renewed = renewedSessionCookie(found);
    expect(renewed.split(";")[0]).toBe(issued.split(";")[0]); // the same name and the same value, byte for byte
    expect(attributes(renewed)).toEqual(attributes(issued));
    expect(await whoIs(browser({ cookie: renewed.split(";")[0]! }))).not.toBeNull(); // and it still resolves
  });

  it("and on https, with the __Secure- prefix", async () => {
    const httpsBase = "https://cms.forgelinetechnologies.com";
    const saved = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = httpsBase; // email links must match the app origin
    resetEnvCache();
    setAuthForTests(createAuth({ baseURL: httpsBase, secret: SECRET }));
    try {
      const { setCookies } = await signUp(
        { name: "Https", email: newEmail(), password: PASSWORD },
        { headers: new Headers({ origin: httpsBase, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }) },
      );
      const issued = setCookies.find((c) => c.startsWith(`${SECURE_SESSION_COOKIE}=`))!;
      const found = findSessionCookie(cookieHeader(setCookies))!;
      expect(found.name).toBe(SECURE_SESSION_COOKIE);
      const renewed = renewedSessionCookie(found);
      expect(renewed.split(";")[0]).toBe(issued.split(";")[0]);
      expect(attributes(renewed)).toEqual(attributes(issued));
      expect(attributes(renewed)).toMatchObject({ secure: true, httponly: true, samesite: "Lax", path: "/", "max-age": "604800" });
    } finally {
      process.env.APP_ORIGIN = saved;
      resetEnvCache();
    }
  });
});

describe("where a login may go next", () => {
  it("only to a page of this app (the full table is in the unit tests)", () => {
    expect(safeNextPath("/acme-org/sites?tab=members")).toBe("/acme-org/sites?tab=members");
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "/.//evil.example", "/s/acme", "/api/auth/sign-out", "/login"]) {
      expect(safeNextPath(next), next).toBe("/");
    }
  });
});
