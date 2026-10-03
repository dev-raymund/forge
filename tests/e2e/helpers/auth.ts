import { randomBytes, randomInt } from "node:crypto";
import type { Page } from "@playwright/test";

/**
 * Auth helpers for E2E (M2-1). There is no auth UI yet (M2-2/M2-3), so tests
 * drive the auth API from a real browser page on the app origin: the browser
 * adds Origin and Sec-Fetch-* and keeps the HttpOnly cookie, as the forms will.
 */

export const PASSWORD = "correct horse battery staple";
export const SESSION_COOKIE = "better-auth.session_token";
export const newEmail = () => `e2e-${randomBytes(5).toString("hex")}@example.test`;

/**
 * Better Auth rate-limits per client IP (3 sign-ins per 10 s). Every test would
 * share one address locally, so each presents its own, as distinct visitors would.
 * On Vercel the platform sets this header and a client cannot override it.
 */
export async function asUniqueVisitor(page: Page) {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  await page.context().setExtraHTTPHeaders({
    "x-forwarded-for": `10.${randomInt(1, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`,
    ...(bypass ? { "x-vercel-protection-bypass": bypass, "x-vercel-set-bypass-cookie": "true" } : {}),
  });
}

export type ApiResult = { status: number; body: unknown };

/** POSTs JSON from inside the page, as the app's own forms will. */
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

export const signUp = (page: Page, email: string, name = "Ada E2E") =>
  browserPost(page, "/api/auth/sign-up/email", { email, password: PASSWORD, name });
export const signIn = (page: Page, email: string, password = PASSWORD) =>
  browserPost(page, "/api/auth/sign-in/email", { email, password });
export const signOut = (page: Page) => browserPost(page, "/api/auth/sign-out");

/** The authenticated route: 200 with the user, or 401. */
export async function currentSession(page: Page) {
  const res = await page.request.get("/api/app/session");
  return { status: res.status(), headers: res.headers(), body: await res.json() };
}

export async function sessionCookie(page: Page) {
  return (await page.context().cookies()).find((c) => c.name.endsWith(SESSION_COOKIE));
}
