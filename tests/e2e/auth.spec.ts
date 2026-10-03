import { expect, test } from "@playwright/test";
import {
  asUniqueVisitor, browserPost, currentSession, newEmail, PASSWORD, sessionCookie, signIn, signOut, signUp,
} from "./helpers/auth";
import { countEmails, emailHeaders, firstLink, waitForEmail } from "./helpers/mailbox";
import { seedSite } from "./helpers/sites";

/**
 * M2-1 end to end against the production build: Better Auth at /api/auth,
 * emails through `email.send` into the local Mailpit inbox, and Forge's session
 * helper behind /api/app/session. No Resend, no Google. The auth pages
 * themselves arrive with M2-2/M2-3; here a real browser calls the API.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NEW_PASSWORD = "an entirely new passphrase";

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
  await page.goto("/");
});

test("sign up → verify by email → signed-in route → log out → no access → log in", async ({ page, playwright, baseURL }) => {
  const email = newEmail();

  // Anonymous: the authenticated route answers 401, as problem+json.
  const anonymous = await currentSession(page);
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers["content-type"]).toBe("application/problem+json");
  expect(anonymous.body).toMatchObject({ type: "urn:forge:problem:unauthenticated", status: 401 });

  // Sign up: signed in at once, with an HttpOnly, host-only, SameSite=Lax cookie.
  expect((await signUp(page, email)).status).toBe(200);
  const cookie = (await sessionCookie(page))!;
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/", domain: "localhost" });
  expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");

  const signedIn = await currentSession(page);
  expect(signedIn.status).toBe(200);
  expect(signedIn.headers["cache-control"]).toBe("no-store");
  expect(signedIn.body).toMatchObject({ user: { email, name: "Ada E2E", emailVerified: false } });
  expect(signedIn.body.session.id).toMatch(UUID);
  expect(JSON.stringify(signedIn.body)).not.toContain(decodeURIComponent(cookie.value).split(".")[0]); // never the token

  // The verification email arrives through the job runner; its link verifies the address.
  const mail = await waitForEmail(email, { subject: "Verify your email for Forge" });
  expect(mail.From.Address).toMatch(/^no-reply@/);
  expect(mail.Text).toContain("Hi Ada E2E,");
  expect((await emailHeaders(mail.ID))["X-Forge-Idempotency-Key"]![0]).toMatch(UUID);
  const link = firstLink(mail);
  expect(link.startsWith(`${baseURL}/api/auth/verify-email?token=`)).toBe(true);
  await page.goto(link);
  await expect(page).toHaveURL(`${baseURL}/`);
  expect((await currentSession(page)).body).toMatchObject({ user: { email, emailVerified: true } });

  // Log out: the cookie is cleared and the session is gone on the server.
  expect((await signOut(page)).status).toBe(200);
  expect(await sessionCookie(page)).toBeUndefined();
  expect((await currentSession(page)).status).toBe(401);
  const replay = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: `${cookie.name}=${cookie.value}` } });
  expect((await replay.get("/api/app/session")).status()).toBe(401); // a copied cookie no longer works
  await replay.dispose();

  // Wrong password and unknown email are indistinguishable.
  const wrong = await signIn(page, email, "definitely not the password");
  const unknown = await signIn(page, newEmail());
  expect([wrong.status, unknown.status]).toEqual([401, 401]);
  expect(wrong.body).toEqual(unknown.body);
  expect((await currentSession(page)).status).toBe(401);

  // Log in again.
  expect((await signIn(page, email)).status).toBe(200);
  expect((await currentSession(page)).body).toMatchObject({ user: { email, emailVerified: true } });
});

test("password reset by email: new password works, old one and old sessions don't, the link works once", async ({ page, request, baseURL }) => {
  const email = newEmail();
  expect((await signUp(page, email)).status).toBe(200);
  expect((await currentSession(page)).status).toBe(200);

  // Requested from a signed-out client; known and unknown addresses get the same answer.
  const unknownEmail = newEmail();
  const known = await request.post("/api/auth/request-password-reset", { data: { email, redirectTo: "/reset-password" } });
  const unknown = await request.post("/api/auth/request-password-reset", { data: { email: unknownEmail, redirectTo: "/reset-password" } });
  expect([known.status(), unknown.status()]).toEqual([200, 200]);
  expect(await known.json()).toEqual(await unknown.json());

  const mail = await waitForEmail(email, { subject: "Reset your Forge password" });
  const link = firstLink(mail);
  expect(link.startsWith(`${baseURL}/api/auth/reset-password/`)).toBe(true);
  expect(await countEmails(unknownEmail)).toBe(0);

  // The link redirects to the app's own reset page (M2-3) with the token.
  const redirect = await request.get(link, { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  const target = new URL(redirect.headers()["location"]!, baseURL);
  expect(target.origin).toBe(baseURL);
  expect(target.pathname).toBe("/reset-password");
  const token = target.searchParams.get("token")!;

  expect((await request.post("/api/auth/reset-password", { data: { token, newPassword: NEW_PASSWORD } })).status()).toBe(200);
  expect((await currentSession(page)).status).toBe(401); // the session from before the reset is revoked
  expect((await request.post("/api/auth/reset-password", { data: { token, newPassword: "yet another passphrase" } })).status()).toBe(400);

  expect((await signIn(page, email, PASSWORD)).status).toBe(401);
  expect((await signIn(page, email, NEW_PASSWORD)).status).toBe(200);
  expect((await currentSession(page)).body).toMatchObject({ user: { email } });
});

test("requests from another origin can't use the session; redirects stay on the app", async ({ page, playwright, baseURL }) => {
  const email = newEmail();
  expect((await signUp(page, email)).status).toBe(200);
  const cookie = (await sessionCookie(page))!;

  const foreign = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { cookie: `${cookie.name}=${cookie.value}`, origin: "https://evil.example" },
  });
  expect((await foreign.post("/api/auth/sign-out", { data: {} })).status()).toBe(403);
  await foreign.dispose();
  expect((await currentSession(page)).status).toBe(200); // still signed in

  const redirect = await browserPost(page, "/api/auth/request-password-reset", { email, redirectTo: "https://evil.example/steal" });
  expect(redirect.status).toBe(403);
  expect(await countEmails(email)).toBe(1); // only the verification email
});

test("endpoints V1 doesn't use are not exposed, and Google is off without credentials", async ({ page }) => {
  expect((await signUp(page, newEmail())).status).toBe(200);
  for (const path of ["/api/auth/change-email", "/api/auth/delete-user", "/api/auth/link-social", "/api/auth/unlink-account"]) {
    expect((await browserPost(page, path, {})).status, path).toBe(404);
  }
  test.skip(!!process.env.GOOGLE_CLIENT_ID, "Google is configured in this environment");
  expect((await browserPost(page, "/api/auth/sign-in/social", { provider: "google", callbackURL: "/" })).status).toBe(404);
});

test("public site pages on the same host neither see nor set the session", async ({ page }) => {
  const site = await seedSite("auth", "Public tagline");
  const before = await page.request.get(`/s/${site.address}`);
  expect(before.status()).toBe(200);

  expect((await signUp(page, newEmail())).status).toBe(200);
  expect(await sessionCookie(page)).toBeDefined();

  const response = (await page.goto(`/s/${site.address}`))!;
  expect(response.status()).toBe(200);
  expect(await response.headerValue("set-cookie")).toBeNull();
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  await expect(page.getByTestId("tagline")).toHaveText("Public tagline");
  expect((await page.request.post(`/s/${site.address}`, { headers: { "next-action": "x" } })).status()).toBe(404);
  expect((await currentSession(page)).status).toBe(200); // visiting a site does not sign the admin out
});
