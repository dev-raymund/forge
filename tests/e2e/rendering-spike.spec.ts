import { expect, test, type Page } from "@playwright/test";
import { seedSite, setTaglineWithoutInvalidation, type SeededSite } from "./helpers/sites";

/**
 * Site routing (M1-7 as adapted by ADR 0006) and the caching spike (M0-4,
 * ADR 0002), against a production build on ONE host like the V1 deployment:
 * the admin at `/…`, tenant sites at `/s/{address}/…`. Runs unchanged against
 * a deployment with E2E_BASE_URL.
 */

const siteUrl = (site: SeededSite | string, path = "/") =>
  `/s/${typeof site === "string" ? site : site.address}${path === "/" ? "" : path}`;
const cronAuth = process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : undefined;
const tagline = (page: Page) => page.getByTestId("tagline");

async function renderedAt(page: Page, site: SeededSite) {
  await page.goto(siteUrl(site));
  return page.getByTestId("rendered-at").textContent();
}

test("two sites render different content from the same route, with their base path", async ({ page }) => {
  const [a, b] = await Promise.all([seedSite("alpha", "Alpha tagline"), seedSite("beta", "Beta tagline")]);
  await page.goto(siteUrl(a, "/about/team"));
  await expect(page.getByTestId("site-name")).toHaveText(a.name);
  await expect(tagline(page)).toHaveText("Alpha tagline");
  await expect(page.getByTestId("path")).toHaveText("/about/team");
  await expect(page.getByTestId("base-path")).toHaveText(`/s/${a.address}`);
  await page.goto(siteUrl(b));
  await expect(page.getByTestId("site-name")).toHaveText(b.name);
  await expect(tagline(page)).toHaveText("Beta tagline");
});

test("an unknown or malformed site address gets a real 404 status", async ({ page }) => {
  expect((await page.goto(siteUrl("nobody-here", "/anything")))?.status()).toBe(404);
  expect((await page.goto("/s/Not_A_Site"))?.status()).toBe(404);
  expect((await page.goto("/s"))?.status()).toBe(404);
});

test("direct /render/* requests 404", async ({ page }) => {
  const a = await seedSite("render", "x");
  expect((await page.goto(`/render/address~${a.address}`))?.status()).toBe(404);
  expect((await page.goto(siteUrl(a, `/render/address~${a.address}`)))?.status()).toBe(200); // just a path inside the site
});

test("site pages can't reach admin routes, the API or Server Actions", async ({ page }) => {
  const a = await seedSite("guard", "Guarded");
  await page.goto(siteUrl(a, "/dev/cache"));
  await expect(page.getByRole("heading", { name: "Cache spike (S1)" })).toHaveCount(0);
  await expect(page.getByTestId("path")).toHaveText("/dev/cache"); // just a site path

  const api = await page.goto(siteUrl(a, "/api/health"));
  expect(api?.headers()["content-type"]).toContain("text/html"); // the site, not the JSON endpoint

  await page.goto(siteUrl(a));
  const status = await page.evaluate(
    (url) =>
      fetch(url, { method: "POST", headers: { "Next-Action": "7f0000000000000000000000000000000000000000" }, body: "[]" }).then(
        (r) => r.status,
      ),
    siteUrl(a, "/about"),
  );
  expect(status).toBe(404);
});

test("framing: the admin can never be framed; site pages only by the same origin (preview)", async ({ page }) => {
  const a = await seedSite("frame", "x");
  const admin = await page.goto("/");
  expect(admin?.headers()["x-frame-options"]).toBe("DENY");
  expect(admin?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  const site = await page.goto(siteUrl(a));
  expect(site?.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(site?.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(site?.headers()["set-cookie"]).toBeUndefined(); // public pages never set cookies
});

test("every response carries a request id", async ({ page }) => {
  const a = await seedSite("reqid", "x");
  for (const url of [siteUrl(a), "/", "/api/health"]) {
    const res = await page.goto(url);
    // A UUIDv7 locally; Vercel's own id (x-vercel-id) on deployments.
    expect(res?.headers()["x-request-id"], url).toMatch(/^[A-Za-z0-9:._-]{8,128}$/);
  }
});

test("public data is cached: a write without invalidation is not visible", async ({ page }) => {
  const a = await seedSite("cached", "Original");
  const first = await renderedAt(page, a);
  await setTaglineWithoutInvalidation(a, "Sneaky");
  await page.reload();
  await expect(tagline(page)).toHaveText("Original");
  expect(await page.getByTestId("rendered-at").textContent()).toBe(first);
});

test("Server Action publish (updateTag): fresh on the very next request, other sites untouched", async ({ page, context }) => {
  const [a, b] = await Promise.all([seedSite("action", "Before"), seedSite("bystander", "Unchanged")]);
  const site = await context.newPage();
  await site.goto(siteUrl(a));
  await expect(tagline(site)).toHaveText("Before");
  const bRenderedAt = await renderedAt(site, b);

  await page.goto("/dev/cache");
  const row = page.locator(`li[data-address="${a.address}"]`);
  await row.getByRole("textbox").fill("After action");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined),
    row.getByRole("button", { name: "Publish" }).click(),
  ]);

  await site.goto(siteUrl(a));
  await expect(tagline(site)).toHaveText("After action");
  expect(await renderedAt(site, b)).toBe(bRenderedAt); // B's cache entry survived
});

test("job-style route handler (revalidateTag, expire: 0): fresh on the very next request", async ({ page, request }) => {
  const a = await seedSite("job", "Before");
  await page.goto(siteUrl(a));
  await expect(tagline(page)).toHaveText("Before");

  const res = await request.post("/api/dev/revalidate", {
    data: { orgId: a.orgId, siteId: a.siteId, tagline: "After job" },
    headers: cronAuth,
  });
  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ ok: true, flushed: { immediate: [`site:${a.siteId}:config`], stale: [] } });

  await page.goto(siteUrl(a));
  await expect(tagline(page)).toHaveText("After job");
});
