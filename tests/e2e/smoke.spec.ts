import { expect, test } from "@playwright/test";

test("admin host serves the admin shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Forge" })).toBeVisible();
});

test("health endpoint answers", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ ok: true });
});

test("readiness reports the database and env groups without naming variables", async ({ request }) => {
  const res = await request.get("/api/health/ready");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("no-store");
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, checks: { database: "ok", env: { core: "ok", database: "ok" } } });
  expect(JSON.stringify(body)).not.toMatch(/[A-Z]+_[A-Z]+/);
});

test("the Sentry test route is invisible without the cron secret", async ({ request }) => {
  const res = await request.post("/api/internal/sentry-test", { headers: { authorization: "Bearer wrong" } });
  expect(res.status()).toBe(404);
  expect(res.headers()["content-type"]).toBe("application/problem+json");
  expect(await res.json()).toMatchObject({ type: "urn:forge:problem:not-found", status: 404 });
});
