import { randomBytes, randomInt } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Auth helpers for E2E. The flows go through the real pages (M2-2); a few
 * security checks still call the auth API directly from the page, as an
 * attacker's script on the same origin would.
 */

export const PASSWORD = "correct horse battery staple";
export const SESSION_COOKIE = "better-auth.session_token";
export const newEmail = () => `e2e-${randomBytes(5).toString("hex")}@example.test`;

/**
 * Better Auth rate-limits per client address (3 sign-ins per 10 s). Every test
 * would share one address locally, so each presents its own, as distinct
 * visitors would. On Vercel the platform sets this header and a client cannot
 * override it.
 */
export async function asUniqueVisitor(page: Page) {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  await page.context().setExtraHTTPHeaders({
    "x-forwarded-for": `10.${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`,
    ...(bypass ? { "x-vercel-protection-bypass": bypass, "x-vercel-set-bypass-cookie": "true" } : {}),
  });
}

// ── The pages ────────────────────────────────────────────────────────────────

export const passwordField = (page: Page, label = "Password") => page.getByLabel(label, { exact: true });

/** Fills and submits the sign-up form; ends on the verification-pending screen. */
export async function signUp(page: Page, email: string, { name = "Ada E2E", password = PASSWORD } = {}) {
  await page.goto("/signup");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await passwordField(page).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/verify-email$/);
}

/** Fills and submits the login form on the current page (or /login). Does not wait for the outcome. */
export async function submitLogin(page: Page, email: string, password = PASSWORD) {
  if (!new URL(page.url()).pathname.startsWith("/login")) await page.goto("/login");
  // After a failed attempt React clears the password a moment after the error
  // appears; typing before that would be wiped (a person is never that fast).
  await expect(passwordField(page)).toHaveValue("");
  await page.getByLabel("Email").fill(email);
  await passwordField(page).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

/** Logs out through the account menu (on the home page, going there first if needed). */
export async function logOut(page: Page) {
  const menu = page.getByRole("button", { name: "Account menu" });
  if (!(await menu.isVisible())) await page.goto("/");
  await menu.click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login\?reason=signed-out$/);
}

// ── The session, as the server sees it ───────────────────────────────────────

/** The authenticated route: 200 with the user, or 401. */
export async function currentSession(page: Page) {
  const res = await page.request.get("/api/app/session");
  return { status: res.status(), headers: res.headers(), body: await res.json() };
}

export async function sessionCookie(page: Page) {
  return (await page.context().cookies()).find((c) => c.name.endsWith(SESSION_COOKIE));
}

export type ApiResult = { status: number; body: unknown };

/** POSTs JSON to the auth API from inside the page (same origin, with the browser's cookies). */
export function browserPost(page: Page, path: string, body: unknown = {}): Promise<ApiResult> {
  return page.evaluate(
    async ([url, payload]) => {
      const res = await fetch(url as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [path, body] as const,
  );
}

// ── Direct database changes (identity tables: no tenant context) ─────────────

const databaseUrl = process.env.DATABASE_URL ?? "postgres://forge_app:forge_app@localhost:6432/forge";

async function sql(text: string, values: unknown[]) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

/** Makes every session of the user idle-expired, as if a week had passed. */
export const expireSessionsOf = (email: string) =>
  sql("update auth_sessions set expires_at = now() - interval '1 minute' where user_id = (select id from users where email = $1)", [email]);
