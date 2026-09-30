import { expect, test } from "@playwright/test";
import { E2E_CRON_SECRET } from "./helpers/env";

/** M1-3: the cron endpoints Vercel calls (vercel.json). Serial: the runner test would otherwise consume the daily job mid-test. */
test.describe.configure({ mode: "serial" });

const auth = { authorization: `Bearer ${E2E_CRON_SECRET}` };

for (const path of ["/api/internal/cron", "/api/internal/cron/daily"]) {
  test(`${path} can't be triggered without the cron secret`, async ({ request }) => {
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong-secret-0123456789" },
      { authorization: E2E_CRON_SECRET }, // the secret without "Bearer"
    ];
    for (const headers of attempts) {
      const res = await request.get(path, { headers });
      expect(res.status(), JSON.stringify(headers)).toBe(404);
      expect(res.headers()["content-type"]).toBe("application/problem+json");
    }
  });
}

test("the runner runs with the cron secret and reports what it did", async ({ request }) => {
  const res = await request.get("/api/internal/cron", { headers: auth });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, stoppedBy: expect.any(String), claimed: expect.any(Number) });
});

test("the daily cron enqueues the maintenance jobs once per day", async ({ request }) => {
  const first = await (await request.get("/api/internal/cron/daily", { headers: auth })).json();
  const second = await (await request.get("/api/internal/cron/daily", { headers: auth })).json();
  expect(first.enqueued.map((j: { type: string }) => j.type)).toEqual(["jobs.cleanup"]);
  expect(second.enqueued[0]).toMatchObject({ type: "jobs.cleanup", id: first.enqueued[0].id, deduplicated: true });

  // The minute runner picks it up.
  const run = await (await request.get("/api/internal/cron", { headers: auth })).json();
  expect(run.succeeded).toBeGreaterThanOrEqual(1);
});
