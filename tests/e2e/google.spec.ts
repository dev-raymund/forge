import { expect, test, type Page } from "@playwright/test";
import { asUniqueVisitor, currentSession, logOut, newEmail, PASSWORD, submitLogin } from "./helpers/auth";
import { E2E_GOOGLE_CLIENT_ID, E2E_MAIN_ORIGIN } from "./helpers/env";

/**
 * M2-3: the Google side of the login and sign-up screens, on a server that has
 * Google sign-in configured (placeholder credentials, see playwright.config.ts).
 *
 * Google itself is never contacted: the navigation to accounts.google.com is
 * answered by a stub. A real round trip needs a real Google account and a real
 * client secret (the server exchanges the code with Google directly), so the
 * callback, the linking rule and session creation are covered in
 * tests/integration/auth-google.test.ts instead.
 *
 * This server shares the database, and so the job queue, with the main E2E
 * server, and an email job is only valid for the origin that queued it. Tests
 * here must therefore not trigger emails (no sign-up, no reset): accounts are
 * created through the main server.
 */

const formAlert = (page: Page) => page.locator('[data-form-alert][role="alert"]');
const home = (page: Page) => page.getByRole("heading", { level: 1, name: /^Welcome, / });

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>Google (stub)</title><h1>Sign in with Google (stub)</h1>" }),
  );
});

/** Clicks the Google button and returns the authorization URL the browser was sent to. */
async function leaveForGoogle(page: Page, button = "Continue with Google") {
  await page.getByRole("button", { name: button }).click();
  await page.waitForURL(/^https:\/\/accounts\.google\.com\//);
  await expect(page.getByRole("heading", { name: "Sign in with Google (stub)" })).toBeVisible();
  return new URL(page.url());
}

test("the Google button is offered on the login and sign-up screens, next to the email form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("separator")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();

  await page.goto("/signup");
  await expect(page.getByRole("button", { name: "Sign up with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();

  // Reachable by keyboard, before the email field.
  await page.goto("/login");
  const google = page.getByRole("button", { name: "Continue with Google" });
  await google.focus();
  await expect(google).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
});

test("it leaves for Google with the code flow, PKCE, a state bound to this browser, and this app's callback", async ({ page, baseURL }) => {
  await page.goto("/login?next=%2Facme-org%2Fsites");
  const authorize = await leaveForGoogle(page);

  expect(authorize.origin + authorize.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  const q = authorize.searchParams;
  expect(q.get("client_id")).toBe(E2E_GOOGLE_CLIENT_ID);
  expect(q.get("response_type")).toBe("code");
  expect(q.get("redirect_uri")).toBe(`${baseURL}/api/auth/callback/google`);
  expect(q.get("code_challenge_method")).toBe("S256");
  expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(q.get("scope")!.split(" ").sort()).toEqual(["email", "openid", "profile"]);
  expect(q.get("prompt")).toBe("select_account");
  expect(authorize.toString()).not.toMatch(/secret/i);

  const cookies = await page.context().cookies(baseURL);
  const state = cookies.find((c) => c.name === "better-auth.state")!;
  expect(state).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  expect(cookies.find((c) => c.name.endsWith("session_token"))).toBeUndefined(); // nobody is signed in yet
});

test("coming back without success lands on the login page, signed out, with our own explanation", async ({ page, baseURL }) => {
  // The user presses "Cancel" at Google.
  await page.goto("/login?next=%2Facme-org%2Fsites");
  const state = (await leaveForGoogle(page)).searchParams.get("state")!;
  await page.goto(`/api/auth/callback/google?error=access_denied&state=${state}`);
  await expect(page).toHaveURL(new RegExp(`^${baseURL}/login\\?next=%2Facme-org%2Fsites&error=access_denied`));
  await expect(formAlert(page)).toHaveText("Google sign-in was cancelled.");
  await expect(page.locator('form[aria-label="Log in"] input[name="next"]')).toHaveValue("/acme-org/sites");
  expect((await currentSession(page)).status).toBe(401);

  // A callback nobody started (a forged or replayed link).
  await page.goto("/api/auth/callback/google?code=stolen-code&state=a-state-this-browser-never-had");
  await expect(page).toHaveURL(`${baseURL}/login?error=state_mismatch`);
  await expect(formAlert(page)).toHaveText("We couldn't sign you in with Google. Please try again.");
  expect((await currentSession(page)).status).toBe(401);

  // The state from before was used up by the cancelled attempt.
  await page.goto(`/api/auth/callback/google?code=late-code&state=${state}`);
  await expect(page).toHaveURL(new RegExp(`^${baseURL}/login\\?.*error=`));
  expect((await currentSession(page)).status).toBe(401);

  // Whatever is written into the address is never shown.
  await page.goto(`/login?error=${encodeURIComponent("Your account is locked. Call 555-0100")}`);
  await expect(formAlert(page)).toHaveText("We couldn't sign you in with Google. Please try again.");
  await expect(page.getByText("555-0100")).toHaveCount(0);

  // The explanation goes away once the form is used.
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByLabel("Email")).toHaveAccessibleDescription("Enter your email address.");
  await expect(formAlert(page)).toHaveCount(0);
});

test("the destination after Google is reduced to a page of this app before the flow starts", async ({ page, baseURL }) => {
  await page.goto(`/login?next=${encodeURIComponent("https://evil.example/")}`);
  await expect(page.locator('form[aria-label="Continue with Google"] input[name="next"]')).toHaveValue("/");
  // A forged hidden field is reduced again on the server: the failure path shows where it would have gone.
  await page.locator('form[aria-label="Continue with Google"] input[name="next"]').evaluate((input: HTMLInputElement) => (input.value = "//evil.example"));
  const state = (await leaveForGoogle(page)).searchParams.get("state")!;
  await page.goto(`/api/auth/callback/google?error=access_denied&state=${state}`);
  await expect(page).toHaveURL(new RegExp(`^${baseURL}/login\\?error=access_denied`));
  expect(page.url()).not.toContain("evil.example");
});

test("email and password work as before on a server with Google configured", async ({ page, playwright }) => {
  // The account is created on the main server (see the note at the top), in a context of its own.
  const email = newEmail();
  const main = await playwright.request.newContext({ baseURL: E2E_MAIN_ORIGIN, extraHTTPHeaders: { origin: E2E_MAIN_ORIGIN } });
  const created = await main.post("/api/auth/sign-up/email", { data: { name: "Ada E2E", email, password: PASSWORD } });
  expect(created.status()).toBe(200);
  await main.dispose();

  await submitLogin(page, email);
  await expect(home(page)).toHaveText("Welcome, Ada E2E");
  expect((await currentSession(page)).body).toMatchObject({ user: { email } });
  await logOut(page);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  expect((await currentSession(page)).status).toBe(401);
});
