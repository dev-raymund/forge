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
