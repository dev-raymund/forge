import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  anotherBrowser, asUniqueVisitor, currentSession, logOut, newEmail, PASSWORD, passwordField, sessionCookie, signUp, submitLogin,
} from "./helpers/auth";
import { waitForEmail } from "./helpers/mailbox";

/**
 * M2-4 end to end against the production build: the account page, and session
 * management with several real browsers. A "session" here is a browser context
 * that logged in; "revoked" is checked from that browser, which still has its
 * cookie, on its next request.
 */

const NEW_PASSWORD = "an entirely new passphrase";
type Scope = Page | Locator;
const formAlert = (scope: Scope) => scope.locator('[data-form-alert][role="alert"]');
const status = (scope: Scope) => scope.locator('[data-form-alert][role="status"]');
const sessions = (page: Page) => page.getByTestId("session");
const sessionAt = (page: Page, ip: string) => sessions(page).filter({ hasText: `IP address ${ip}` });
const section = (page: Page, name: string) => page.getByRole("region", { name });

let ip: string;
test.beforeEach(async ({ page }) => {
  ip = await asUniqueVisitor(page);
});

test("the account page needs a session, and login comes back to it", async ({ page, request, baseURL }) => {
  const anonymous = await request.get("/account", { maxRedirects: 0 });
  expect(anonymous.status()).toBe(307);
  expect(anonymous.headers()["location"]).toBe("/login?next=%2Faccount");

  const email = newEmail();
  await signUp(page, email);
  await logOut(page);
  await page.goto("/account");
  await expect(page).toHaveURL(`${baseURL}/login?next=%2Faccount`);
  await submitLogin(page, email);
  await expect(page).toHaveURL(`${baseURL}/account`);
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

  // A forged cookie gets no further than an expired one.
  const cookie = (await sessionCookie(page))!;
  await page.context().addCookies([{ ...cookie, value: "forged.value" }]);
  await page.goto("/account");
  await expect(page).toHaveURL(`${baseURL}/login?next=%2Faccount&reason=session`);
});

test("shows the signed-in user's own account, and lets them change their name", async ({ page }) => {
  const email = newEmail();
  await signUp(page, email, { name: "Ada Account" });
  await page.goto("/");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

  // Profile: the name is editable; the address is shown with its state and is not a field.
  const profile = section(page, "Profile");
  await expect(profile.getByLabel("Name")).toHaveValue("Ada Account");
  await expect(page.getByTestId("account-email")).toHaveText(email);
  await expect(page.getByTestId("account-email-status")).toContainText("Not verified");
  await expect(profile.getByRole("link", { name: "Verify email" })).toBeVisible();
  await expect(page.locator('input[type="email"], input[name="email"], input[type="file"]')).toHaveCount(0);

  // Sign-in methods are read-only.
  const methods = page.getByTestId("sign-in-methods");
  await expect(methods.locator('[data-method="password"]')).toContainText("Set");
  await expect(methods.locator('[data-method="google"]')).toContainText("Not connected");
  await expect(section(page, "Sign-in methods").getByRole("button")).toHaveCount(0);

  // One session: this one, recognisable, with no way to end it from the list.
  await expect(sessions(page)).toHaveCount(1);
  await expect(sessions(page)).toContainText("This device");
  await expect(sessions(page)).toContainText(/Chrome on \w+/);
  await expect(sessions(page)).toContainText(`IP address ${ip}`);
  await expect(section(page, "Sessions").getByRole("button")).toHaveCount(0);
  await expect(page.getByText("This is your only active session.")).toBeVisible();

  // Nothing that identifies a session inside Forge reaches the browser.
  const cookie = (await sessionCookie(page))!;
  const html = await page.content();
  expect(html).not.toContain(decodeURIComponent(cookie.value).split(".")[0]);
  expect((await currentSession(page)).body.session).toEqual({ expiresAt: expect.any(String) });

  // An empty name is refused in place; a new one is saved and shows in the header.
  await profile.getByLabel("Name").fill("   ");
  await profile.getByRole("button", { name: "Save name" }).click();
  await expect(profile.getByLabel("Name")).toHaveAccessibleDescription("Enter your name.");
  await expect(profile.getByLabel("Name")).toBeFocused();
  await profile.getByLabel("Name").fill("Grace Hopper");
  await profile.getByRole("button", { name: "Save name" }).click();
  await expect(status(profile)).toHaveText("Your name has been updated.");
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("menu")).toContainText("Grace Hopper");
  await page.keyboard.press("Escape");
  expect((await currentSession(page)).body.user).toMatchObject({ name: "Grace Hopper", email });
});

test("sessions: three browsers of one user, and another user who must not be touched", async ({ page, browser, baseURL }) => {
  test.slow(); // four logged-in browsers
  const email = newEmail();
  await signUp(page, email, { name: "User A" });
  const b = await anotherBrowser(browser, email);
  const c = await anotherBrowser(browser, email);

  // Another user, with two sessions of their own.
  const otherEmail = newEmail();
  const d = await browser.newContext();
  const other = await d.newPage();
  await asUniqueVisitor(other);
  await signUp(other, otherEmail, { name: "User D" });
  const d2 = await anotherBrowser(browser, otherEmail);

  // A sees exactly its own three sessions; D sees its own two.
  await page.goto("/account");
  await expect(sessions(page)).toHaveCount(3);
  await expect(sessions(page).filter({ hasText: "This device" })).toHaveCount(1);
  await expect(sessionAt(page, ip)).toContainText("This device");
  await expect(sessionAt(page, b.ip)).toHaveCount(1);
  await expect(sessionAt(page, c.ip)).toHaveCount(1);
  await expect(sessionAt(page, d2.ip)).toHaveCount(0);
  await other.goto("/account");
  await expect(sessions(other)).toHaveCount(2);
  await expect(sessionAt(other, b.ip)).toHaveCount(0);

  // A sends the handle of D's other session instead of one of its own: refused, and D is untouched.
  const foreignHandle = await sessionAt(other, d2.ip).getByRole("button").getAttribute("value");
  expect(foreignHandle).toMatch(/^[A-Za-z0-9_-]{32}$/);
  await sessionAt(page, b.ip).getByRole("button").evaluate((button: HTMLButtonElement, value) => (button.value = value), foreignHandle!);
  await sessionAt(page, b.ip).getByRole("button").click();
  await expect(formAlert(section(page, "Sessions"))).toHaveText("Not found.");
  expect((await currentSession(d2.page)).status).toBe(200);
  expect((await currentSession(b.page)).status).toBe(200);
  await page.reload();
  await expect(sessions(page)).toHaveCount(3);

  // B has its account page open while A ends B's session.
  await b.page.goto("/account");
  await expect(sessions(b.page)).toHaveCount(3);
  await sessionAt(page, b.ip).getByRole("button", { name: /^Log out the session on / }).click();
  await expect(status(section(page, "Sessions"))).toHaveText("That session has been logged out.");
  await expect(sessions(page)).toHaveCount(2);
  await expect(sessionAt(page, b.ip)).toHaveCount(0);

  // B still has its cookie and an open page. Its very next action is refused and ends at the login page.
  expect(await sessionCookie(b.page)).toBeDefined();
  await section(b.page, "Profile").getByLabel("Name").fill("Changed By A Dead Session");
  await section(b.page, "Profile").getByRole("button", { name: "Save name" }).click();
  await expect(b.page).toHaveURL(`${baseURL}/login?next=%2Faccount&reason=session`);
  await expect(status(b.page)).toHaveText("Your session has ended. Log in again to continue.");
  expect((await currentSession(b.page)).status).toBe(401);
  expect((await currentSession(page)).body.user.name).toBe("User A"); // nothing was saved
  // A and C carry on.
  expect((await currentSession(page)).status).toBe(200);
  expect((await currentSession(c.page)).status).toBe(200);

  // B logs in again; A ends every other session at once.
  await submitLogin(b.page, email);
  await expect(b.page).toHaveURL(`${baseURL}/account`);
  await page.reload();
  await expect(sessions(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Log out all other sessions" }).click();
  await expect(status(section(page, "Sessions"))).toHaveText("2 other sessions have been logged out.");
  await expect(sessions(page)).toHaveCount(1);
  await expect(sessions(page)).toContainText("This device");
  await expect(page.getByText("This is your only active session.")).toBeVisible();

  expect((await currentSession(page)).status).toBe(200); // the current session survives
  expect((await currentSession(b.page)).status).toBe(401);
  expect((await currentSession(c.page)).status).toBe(401);
  await c.page.goto("/");
  await expect(c.page).toHaveURL(new RegExp(`^${baseURL}/login`));
  // The other user's sessions were never part of it.
  expect((await currentSession(other)).status).toBe(200);
  expect((await currentSession(d2.page)).status).toBe(200);
  await other.reload();
  await expect(sessions(other)).toHaveCount(2);

  for (const context of [b.context, c.context, d, d2.context]) await context.close();
});

test("change password: errors in place, then the change logs out the other sessions and emails a notice", async ({ page, browser, baseURL }) => {
  const email = newEmail();
  await signUp(page, email);
  const b = await anotherBrowser(browser, email);
  await page.goto("/account");
  const password = section(page, "Password");
  const current = passwordField(password, "Current password");
  const next = passwordField(password, "New password");
  await expect(password.getByText("At least 12 characters.", { exact: false })).toBeVisible();

  // Empty and too short: refused in the browser, with focus on the first problem.
  await password.getByRole("button", { name: "Change password" }).click();
  await expect(current).toHaveAccessibleDescription("Enter your current password.");
  await expect(current).toBeFocused();
  await current.fill(PASSWORD);
  await next.fill("too short");
  await password.getByRole("button", { name: "Change password" }).click();
  await expect(next).toHaveAccessibleDescription(/Use at least 12 characters\./);

  // A wrong current password: refused by the server, on that field; nothing changes.
  await current.fill("definitely not my password");
  await next.fill(NEW_PASSWORD);
  await password.getByRole("button", { name: "Change password" }).click();
  await expect(current).toHaveAccessibleDescription("Your current password is incorrect.");
  await expect(current).toBeFocused();
  await expect(current).toHaveValue(""); // never echoed back
  expect((await currentSession(b.page)).status).toBe(200);

  // The right one.
  await current.fill(PASSWORD);
  await next.fill(NEW_PASSWORD);
  await password.getByRole("button", { name: "Change password" }).click();
  await expect(status(password)).toHaveText("Your password has been changed. Your other sessions have been logged out.");
  await expect(current).toHaveValue("");
  await expect(next).toHaveValue("");

  // This browser stays signed in (on a new session); the other one is out.
  expect((await currentSession(page)).status).toBe(200);
  await expect(sessions(page)).toHaveCount(1);
  expect((await currentSession(b.page)).status).toBe(401);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

  // The notice from M2-3 arrives, with nothing secret in it.
  const notice = await waitForEmail(email, { subject: "Your Forge password was changed" });
  expect(notice.Text).toContain(`The password for the Forge account ${email} was changed on`);
  for (const secret of [PASSWORD, NEW_PASSWORD]) expect(notice.Text + notice.HTML).not.toContain(secret);

  // Only the new password logs in.
  await logOut(page);
  await submitLogin(page, email, PASSWORD);
  await expect(formAlert(page)).toHaveText("Email or password is incorrect.");
  await submitLogin(page, email, NEW_PASSWORD);
  await expect(page).toHaveURL(`${baseURL}/`);
  await b.context.close();
});

test("the account page works with the keyboard and logs out from its menu", async ({ page }) => {
  const email = newEmail();
  await signUp(page, email);
  await page.goto("/account");
  const name = section(page, "Profile").getByLabel("Name");
  await name.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Keyboard Only");
  await page.keyboard.press("Enter");
  await expect(status(section(page, "Profile"))).toHaveText("Your name has been updated.");

  // Tab order follows the page: name → save → verify link → current password …
  await name.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Save name" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(section(page, "Profile").getByRole("link", { name: "Verify email" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(passwordField(page, "Current password")).toBeFocused();

  await logOut(page);
  expect((await currentSession(page)).status).toBe(401);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the account page fits the screen with several sessions listed", async ({ page, browser }) => {
    const email = newEmail();
    await signUp(page, email, { name: "A Rather Long Display Name For A Small Screen" });
    const b = await anotherBrowser(browser, email);
    await page.goto("/account");
    await expect(sessions(page)).toHaveCount(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "the account page scrolls sideways").toBeLessThanOrEqual(0);
    const button = await sessions(page).getByRole("button").first().boundingBox();
    expect(Math.min(button!.width, button!.height)).toBeGreaterThanOrEqual(24); // WCAG 2.2 target size
    await sessions(page).getByRole("button").first().click();
    await expect(sessions(page)).toHaveCount(1);
    expect((await currentSession(b.page)).status).toBe(401);
    await b.context.close();
  });
});
