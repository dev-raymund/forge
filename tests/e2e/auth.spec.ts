import { expect, test } from "@playwright/test";
import {
  accountMenu, asUniqueVisitor, browserPost, currentSession, expireSessionsOf, landing, LANDING_PATH, logOut, newEmail, PASSWORD, passwordField,
  SESSION_COOKIE, sessionCookie, signUp, submitLogin,
} from "./helpers/auth";
import { countEmails, emailHeaders, firstLink, waitForEmail } from "./helpers/mailbox";
import { seedSite } from "./helpers/sites";

/**
 * M2-1 + M2-2 end to end against the production build: the account screens,
 * their Server Actions, Better Auth behind them, emails through `email.send`
 * into the local Mailpit inbox. No Resend, no Google, no Turnstile.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NEW_PASSWORD = "an entirely new passphrase";
// Next's own route announcer is also role="alert"; this is the form's.
const alert = (page: import("@playwright/test").Page) => page.locator('[data-form-alert][role="alert"]');
const notice = (page: import("@playwright/test").Page) => page.locator('[data-form-alert][role="status"]');

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test.describe("anonymous visitors", () => {
  test("protected admin routes redirect to the login page; public routes do not", async ({ page, request, baseURL }) => {
    const root = await request.get("/", { maxRedirects: 0 });
    expect(root.status()).toBe(307);
    expect(root.headers()["location"]).toBe("/login");

    const deep = await request.get("/acme-org/sites?tab=members", { maxRedirects: 0 });
    expect(deep.status()).toBe(307);
    expect(deep.headers()["location"]).toBe("/login?next=%2Facme-org%2Fsites%3Ftab%3Dmembers");

    await page.goto("/");
    await expect(page).toHaveURL(`${baseURL}/login`);
    await expect(page.getByRole("heading", { level: 1, name: "Log in to Forge" })).toBeVisible();

    // Route handlers answer for themselves: 401 as problem+json, never a login page.
    const api = await request.get("/api/app/session", { maxRedirects: 0 });
    expect(api.status()).toBe(401);
    expect(api.headers()["content-type"]).toBe("application/problem+json");
    expect(await api.json()).toMatchObject({ type: "urn:forge:problem:unauthenticated", status: 401 });
    expect((await request.get("/api/health", { maxRedirects: 0 })).status()).toBe(200);
    expect((await request.get("/api/auth/ok", { maxRedirects: 0 })).status()).toBe(200);

    // The account screens and public sites need no session.
    for (const path of ["/login", "/signup", "/forgot-password", "/reset-password", "/verify-email"]) {
      expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(200);
    }
    const site = await seedSite("anon", "Open to everyone");
    expect((await request.get(`/s/${site.address}`, { maxRedirects: 0 })).status()).toBe(200);
  });

  test("the verify-email screen without a session explains what to do", async ({ page }) => {
    await page.goto("/verify-email");
    await expect(page.getByTestId("verify-state")).toHaveAttribute("data-state", "anonymous");
    await page.goto("/verify-email?error=INVALID_TOKEN");
    await expect(page.getByTestId("verify-state")).toHaveAttribute("data-state", "invalid");
    await expect(page.getByRole("link", { name: "Log in to get a new link" })).toBeVisible();
    // The query string can't make anyone look verified: this is only a message, with a link to log in.
    await page.goto("/verify-email?status=verified");
    await expect(page.getByTestId("verify-state")).toHaveAttribute("data-state", "confirmed");
    await expect(page.getByRole("link", { name: "Log in to continue" })).toBeVisible();
  });
});

test("sign up → verification pending → verify by email → log out → no access → log in", async ({ page, playwright, baseURL }) => {
  const email = newEmail();

  // Sign up: signed in, and told plainly that the address is not verified yet.
  await signUp(page, email);
  await expect(page.getByTestId("verify-state")).toHaveAttribute("data-state", "pending");
  await expect(page.getByText(email)).toBeVisible();
  const cookie = (await sessionCookie(page))!;
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/", domain: "localhost" });
  expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");
  expect((await currentSession(page)).body).toMatchObject({ user: { email, name: "Ada E2E", emailVerified: false } });

  // The app is usable before verification, with a banner until it is done.
  await page.getByRole("link", { name: "Continue to Forge" }).click();
  await expect(landing(page)).toBeVisible();
  await expect(accountMenu(page)).toContainText("Ada E2E");
  await expect(page.getByTestId("verify-email-banner")).toBeVisible();

  // The email arrives through the job runner; its link verifies the address.
  const mail = await waitForEmail(email, { subject: "Verify your email for Forge" });
  expect(mail.From.Address).toMatch(/^no-reply@/);
  expect(mail.Text).toContain("Hi Ada E2E,");
  expect((await emailHeaders(mail.ID))["X-Forge-Idempotency-Key"]![0]).toMatch(UUID);
  const link = firstLink(mail);
  expect(link.startsWith(`${baseURL}/api/auth/verify-email?token=`)).toBe(true);
  await page.goto(link);
  await expect(page).toHaveURL(`${baseURL}/verify-email?status=verified`);
  await expect(page.getByTestId("verify-state")).toHaveAttribute("data-state", "verified");
  await page.getByRole("link", { name: "Continue to Forge" }).click();
  await expect(landing(page)).toBeVisible();
  await expect(page.getByTestId("verify-email-banner")).toHaveCount(0);
  expect((await currentSession(page)).body).toMatchObject({ user: { email, emailVerified: true } });

  // Log out from the account menu: back on the login page, and the session is gone on the server.
  await logOut(page);
  await expect(notice(page)).toHaveText("You have been logged out.");
  // A full page load: nothing of the signed-in screens is left in the tab.
  expect(await page.content()).not.toContain(email);
  expect(await page.content()).not.toContain("Ada E2E");
  expect(await sessionCookie(page)).toBeUndefined();
  expect((await currentSession(page)).status).toBe(401);
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/login`);
  const replay = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: `${cookie.name}=${cookie.value}` } });
  expect((await replay.get("/api/app/session")).status()).toBe(401); // a copied cookie no longer works
  await replay.dispose();

  // A wrong password and an unknown address get the same answer; the email stays in the form.
  await submitLogin(page, email, "definitely not the password");
  await expect(alert(page)).toHaveText("Email or password is incorrect.");
  await expect(alert(page)).toBeFocused();
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await expect(passwordField(page)).toHaveValue("");
  await submitLogin(page, newEmail());
  await expect(alert(page)).toHaveText("Email or password is incorrect.");
  expect((await currentSession(page)).status).toBe(401);

  // Log in.
  await submitLogin(page, email);
  await expect(landing(page)).toBeVisible();
  await expect(accountMenu(page)).toContainText("Ada E2E");
  expect((await currentSession(page)).body).toMatchObject({ user: { email, emailVerified: true } });
  // Also a full page load: the login form, and the password typed into it, are gone.
  await expect(page.locator('input[type="password"], input[name="password"], input[name="email"]')).toHaveCount(0);
  // The signed-in page is never stored by the browser or a cache (`next dev` sets its own headers).
  const signedIn = (await page.reload())!;
  if (process.env.E2E_SERVER !== "dev") expect(signedIn.headers()["cache-control"]).toContain("no-store");
});

test("log in returns to the page that was asked for, and never leaves the app", async ({ page, baseURL }) => {
  test.slow(); // several full log-out / log-in rounds
  const email = newEmail();
  await signUp(page, email);
  await logOut(page);

  // An anonymous visit to an admin page comes back to it after logging in.
  await page.goto("/acme-org/sites?tab=members");
  await expect(page).toHaveURL(`${baseURL}/login?next=%2Facme-org%2Fsites%3Ftab%3Dmembers`);
  await submitLogin(page, email);
  await expect(page).toHaveURL(`${baseURL}/acme-org/sites?tab=members`);

  // Already signed in: the login and sign-up pages pass straight through.
  await page.goto("/login");
  await expect(landing(page)).toBeVisible();
  await page.goto("/signup");
  await expect(landing(page)).toBeVisible();

  // Anything that isn't a path on this app falls back to `/`: the user's own start page.
  // (The full table of rejected values is in the unit tests of safeNextPath.)
  for (const next of ["https://evil.example/", "//evil.example", "/s/some-site"]) {
    await asUniqueVisitor(page);
    await logOut(page);
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await expect(page.locator('input[name="next"]')).toHaveValue("/");
    await submitLogin(page, email);
    await expect(page, next).toHaveURL(`${baseURL}${LANDING_PATH}`); // `/`, which sends this user on to onboarding
    await expect(landing(page)).toBeVisible();
  }

  // A forged hidden field is checked again on the server.
  await asUniqueVisitor(page);
  await logOut(page);
  await page.goto("/login");
  await page.locator('input[name="next"]').evaluate((input: HTMLInputElement) => (input.value = "https://evil.example/"));
  await submitLogin(page, email);
  await expect(page).toHaveURL(`${baseURL}${LANDING_PATH}`);
});

test("an expired or invalid session ends on the login page with an explanation", async ({ page, baseURL }) => {
  const email = newEmail();
  await signUp(page, email);
  await page.goto("/");
  await expect(landing(page)).toBeVisible();

  // Expired on the server: the browser still has the cookie, the page decides.
  await expireSessionsOf(email);
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/login?reason=session`);
  await expect(notice(page)).toHaveText("Your session has ended. Log in again to continue.");
  expect((await currentSession(page)).status).toBe(401);

  // A forged cookie is no better.
  await page.context().addCookies([{ name: SESSION_COOKIE, value: "forged.value", domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/login?reason=session`);

  // Logging in again from there works.
  await submitLogin(page, email);
  await expect(landing(page)).toBeVisible();
});

test("forms validate in the browser and on the server, and say what is wrong", async ({ page }) => {
  const email = newEmail();

  // Sign-up: a short password is refused before anything is sent, with focus on the field.
  await page.goto("/signup");
  await expect(page.getByText("At least 12 characters.", { exact: false })).toBeVisible();
  await page.getByLabel("Name").fill("Ada E2E");
  await page.getByLabel("Email").fill(email);
  await passwordField(page).fill("too short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(passwordField(page)).toHaveAttribute("aria-invalid", "true");
  await expect(passwordField(page)).toBeFocused();
  await expect(passwordField(page)).toHaveAccessibleDescription(/Use at least 12 characters\./);
  await expect(passwordField(page)).toHaveValue("too short"); // nothing was submitted, nothing was cleared
  expect((await currentSession(page)).status).toBe(401);

  // Empty form: every field says what it needs; focus goes to the first one.
  await page.goto("/signup");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByLabel("Name")).toBeFocused();
  await expect(page.getByLabel("Name")).toHaveAccessibleDescription("Enter your name.");
  await expect(page.getByLabel("Email")).toHaveAccessibleDescription("Enter your email address.");

  // Show / hide password.
  await passwordField(page).fill("visible when asked");
  await expect(passwordField(page)).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(passwordField(page)).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");

  // An address that is already registered.
  await signUp(page, email);
  await logOut(page);
  await page.goto("/signup");
  await page.getByLabel("Name").fill("Someone Else");
  await page.getByLabel("Email").fill(email);
  await passwordField(page).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByLabel("Email")).toHaveAccessibleDescription("An account with this email already exists.");
  await expect(page.getByLabel("Email")).toBeFocused();
  await expect(page.getByLabel("Name")).toHaveValue("Someone Else");
  await expect(page.getByRole("link", { name: "reset your password" })).toBeVisible();

  // Login: empty fields; and it says nothing about password rules.
  await page.goto("/login");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByLabel("Email")).toHaveAccessibleDescription("Enter your email address.");
  await expect(passwordField(page)).toHaveAccessibleDescription("Enter your password.");
  await expect(page.getByText("12 characters")).toHaveCount(0);
});

test("the keyboard alone is enough to log in", async ({ page }) => {
  const email = newEmail();
  await signUp(page, email);
  await logOut(page);

  await page.goto("/login");
  await page.getByLabel("Email").click(); // waits until the streamed form is on screen
  await page.keyboard.type(email);
  await page.keyboard.press("Tab"); // straight to the password: no link in between
  await expect(passwordField(page)).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Show password" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Log in" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(landing(page)).toBeVisible();

  // The account menu too.
  await page.getByRole("button", { name: "Account menu" }).focus();
  await page.keyboard.press("Enter");
  // Opened from the keyboard, the menu puts focus on its first item, and an arrow key moves it.
  // The menu moves focus a tick after the key (a 0 ms timer), so wait to see it land, as a person
  // would, before pressing Enter: without that, a fast machine activates the item still focused.
  await expect(page.getByRole("menuitem", { name: "Account" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Log out" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login\?reason=signed-out$/);
});

test("too many login attempts are slowed down, through the form as well", async ({ page }) => {
  test.skip(process.env.E2E_SERVER === "dev", "Better Auth's limiter is on in production builds only");
  const email = newEmail();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await submitLogin(page, email, `wrong password number ${attempt}`);
    await expect(alert(page)).toHaveText("Email or password is incorrect.");
  }
  await submitLogin(page, email, "wrong password number 4");
  await expect(alert(page)).toHaveText("Too many requests. Please try again shortly.");
});

test("password reset by email: forgot → email → new password → log in", async ({ page, browser, baseURL }) => {
  const email = newEmail();
  await signUp(page, email);

  // A second browser asks for the reset; the first stays signed in for now.
  const other = await browser.newContext();
  const reset = await other.newPage();
  await asUniqueVisitor(reset);

  // An unknown address gets exactly the same screen, and no email.
  const unknown = newEmail();
  await reset.goto("/forgot-password");
  await reset.getByLabel("Email").fill(unknown);
  await reset.getByRole("button", { name: "Send reset link" }).click();
  const confirmation = reset.getByTestId("reset-requested");
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toBeFocused();
  const unknownText = (await confirmation.innerText()).replace(unknown, "{email}");

  await reset.goto("/forgot-password");
  await reset.getByLabel("Email").fill(email);
  await reset.getByRole("button", { name: "Send reset link" }).click();
  await expect(confirmation).toBeVisible();
  expect((await confirmation.innerText()).replace(email, "{email}")).toBe(unknownText);

  const mail = await waitForEmail(email, { subject: "Reset your Forge password" });
  expect(await countEmails(unknown)).toBe(0);
  const link = firstLink(mail);
  expect(link.startsWith(`${baseURL}/api/auth/reset-password/`)).toBe(true);

  // The link opens the form; a short password is refused; a good one is accepted.
  await reset.goto(link);
  await expect(reset).toHaveURL(/\/reset-password\?token=/);
  expect(await reset.locator('meta[name="referrer"]').getAttribute("content")).toBe("no-referrer");
  await passwordField(reset, "New password").fill("short");
  await reset.getByRole("button", { name: "Change password" }).click();
  await expect(passwordField(reset, "New password")).toHaveAccessibleDescription(/Use at least 12 characters\./);
  await passwordField(reset, "New password").fill(NEW_PASSWORD);
  await reset.getByRole("button", { name: "Change password" }).click();
  await expect(reset).toHaveURL(`${baseURL}/login?reason=password-reset`);
  await expect(notice(reset)).toHaveText("Your password has been changed. Log in with your new password.");

  // The account's address is told about the change (M2-3): a notice, with no token and no password in it.
  const changed = await waitForEmail(email, { subject: "Your Forge password was changed" });
  expect(changed.From.Address).toMatch(/^no-reply@/);
  expect(changed.To.map((t) => t.Address)).toEqual([email]);
  expect(changed.Text).toContain(`The password for the Forge account ${email} was changed on`);
  expect(changed.Text).toContain(`${baseURL}/forgot-password`);
  const token = new URL(link).pathname.split("/").pop()!;
  for (const secret of [token, NEW_PASSWORD, PASSWORD]) expect(changed.Text + changed.HTML).not.toContain(secret);
  expect(changed.Text + changed.HTML).not.toMatch(/token=/);

  // The session from before the reset is revoked.
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/login?reason=session`);

  // The link works once.
  await reset.goto(link);
  await expect(reset.getByTestId("reset-link-invalid")).toBeVisible();
  await expect(reset.getByRole("link", { name: "Request a new link" })).toBeVisible();
  await reset.goto("/reset-password");
  await expect(reset.getByTestId("reset-link-invalid")).toBeVisible();

  // Old password no longer works; the new one does.
  await submitLogin(reset, email, PASSWORD);
  await expect(alert(reset)).toHaveText("Email or password is incorrect.");
  await submitLogin(reset, email, NEW_PASSWORD);
  await expect(landing(reset)).toBeVisible();
  await other.close();
});

test("a new verification email can be requested, and an invalid link says so", async ({ page }) => {
  const email = newEmail();
  await signUp(page, email);
  await waitForEmail(email, { subject: "Verify your email for Forge" });

  await page.getByRole("button", { name: "Resend email" }).click();
  await expect(notice(page)).toContainText("We sent a new link");
  await expect.poll(() => countEmails(email)).toBe(2);
  // The button waits before the next send.
  await expect(page.getByRole("button", { name: /You can resend in \d+s/ })).toHaveAttribute("aria-disabled", "true");

  // A tampered link lands on the same screen with an explanation and a way forward.
  const link = firstLink(await waitForEmail(email, { subject: "Verify your email for Forge" }));
  const tampered = new URL(link);
  tampered.searchParams.set("token", `${tampered.searchParams.get("token")!.slice(0, -3)}abc`);
  await page.goto(tampered.toString());
  await expect(page.getByTestId("verify-state")).toHaveAttribute("data-state", "invalid");
  await expect(alert(page)).toHaveText("This link is invalid or has expired.");
  await expect(page.getByRole("button", { name: "Send a new link" })).toBeVisible();
  expect((await currentSession(page)).body).toMatchObject({ user: { emailVerified: false } });
});

test("requests from another origin can't use the session; redirects stay on the app", async ({ page, playwright, baseURL }) => {
  const email = newEmail();
  await signUp(page, email);
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
  // This server has no Google credentials (google.spec.ts covers the configured side): no button, no divider.
  if (!process.env.E2E_BASE_URL) {
    for (const path of ["/login", "/signup"]) {
      await page.goto(path);
      await expect(page.getByRole("button", { name: path === "/login" ? "Log in" : "Create account" })).toBeVisible();
      await expect(page.getByText(/Google/)).toHaveCount(0);
      await expect(page.getByRole("separator")).toHaveCount(0);
    }
  }

  await signUp(page, newEmail());
  for (const path of ["/api/auth/change-email", "/api/auth/delete-user", "/api/auth/link-social", "/api/auth/unlink-account"]) {
    expect((await browserPost(page, path, {})).status, path).toBe(404);
  }
  test.skip(!!process.env.E2E_BASE_URL, "a deployment may have Google configured");
  expect((await browserPost(page, "/api/auth/sign-in/social", { provider: "google", callbackURL: "/" })).status).toBe(404);
});

test("public site pages on the same host neither see nor set the session", async ({ page }) => {
  const site = await seedSite("auth", "Public tagline");
  const anonymous = await page.request.get(`/s/${site.address}`);
  expect(anonymous.status()).toBe(200);

  await signUp(page, newEmail());
  expect(await sessionCookie(page)).toBeDefined();

  const response = (await page.goto(`/s/${site.address}`))!;
  expect(response.status()).toBe(200);
  expect(await response.headerValue("set-cookie")).toBeNull(); // not even the renewed admin cookie
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  await expect(page.getByRole("main")).toContainText("Public tagline");
  await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0); // nothing of the admin
  expect((await page.request.post(`/s/${site.address}`, { headers: { "next-action": "x" } })).status()).toBe(404);
  expect((await currentSession(page)).status).toBe(200); // visiting a site does not sign the admin out

  // An admin page load keeps the browser cookie alive; the value never changes.
  const before = (await sessionCookie(page))!;
  const admin = (await page.goto("/"))!;
  const renewed = await admin.headerValue("set-cookie");
  expect(renewed).toContain(`${before.name}=`);
  expect(renewed).toMatch(/Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/);
  expect((await sessionCookie(page))!.value).toBe(before.value);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the account screens fit the screen and the whole flow works", async ({ page }) => {
    for (const path of ["/login", "/signup", "/forgot-password", "/reset-password", "/verify-email"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    }
    const email = newEmail();
    await signUp(page, email);
    await page.getByRole("link", { name: "Continue to Forge" }).click();
    await expect(landing(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    // Controls are large enough to tap (WCAG 2.2 target size: 24px minimum).
    const menu = await page.getByRole("button", { name: "Account menu" }).boundingBox();
    expect(Math.min(menu!.width, menu!.height)).toBeGreaterThanOrEqual(24);
    await logOut(page);
    await submitLogin(page, email);
    await expect(landing(page)).toBeVisible();
  });
});
