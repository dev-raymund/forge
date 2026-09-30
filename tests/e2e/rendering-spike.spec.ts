import { expect, test, type Page } from "@playwright/test";
import { seedSite, setTaglineWithoutInvalidation, type SeededSite } from "./helpers/sites";

/**
 * Spike S1 (M0-4, ADR 0002) and the M1-7 routing guards, against a production
 * build on *.localhost. The same spec runs against a preview deployment with
 * `?__host=` (runbook), which is the Vercel half of the spike.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
/** Against a deployment (E2E_BASE_URL), tenant hosts are reached with the non-production ?__host= override. */
const external = process.env.E2E_BASE_URL;
const siteUrl = (host: string, path = "/") =>
  external ? `${external}${path}${path.includes("?") ? "&" : "?"}__host=${host}` : `http://${host}:${PORT}${path}`;
const cronAuth = process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : undefined;
const tagline = (page: Page) => page.getByTestId("tagline");

async function renderedAt(page: Page, site: SeededSite) {
  await page.goto(siteUrl(site.host));
  return page.getByTestId("rendered-at").textContent();
}

test("two hosts render different content from the same route", async ({ page }) => {
  const [a, b] = await Promise.all([seedSite("alpha", "Alpha tagline"), seedSite("beta", "Beta tagline")]);
  await page.goto(siteUrl(a.host, "/about/team"));
  await expect(page.getByTestId("site-name")).toHaveText(a.name);
  await expect(tagline(page)).toHaveText("Alpha tagline");
  await expect(page.getByTestId("path")).toHaveText("/about/team");
  await page.goto(siteUrl(b.host));
  await expect(page.getByTestId("site-name")).toHaveText(b.name);
  await expect(tagline(page)).toHaveText("Beta tagline");
});

test("an unknown host gets a real 404 status", async ({ page }) => {
  const res = await page.goto(siteUrl("nobody-here.sites.localhost", "/anything"));
  expect(res?.status()).toBe(404);
});

test("direct /render/* requests 404 on the app host and on site hosts", async ({ page }) => {
  const a = await seedSite("render", "x");
  expect((await page.goto(`/render/${a.host}`))?.status()).toBe(404);
  expect((await page.goto(siteUrl(a.host, `/render/${a.host}`)))?.status()).toBe(404);
});

test("site hosts can't reach admin routes, the API or Server Actions", async ({ page }) => {
  test.skip(!!external, "needs real tenant hostnames; covered by the unit table on deployments");
  const a = await seedSite("guard", "Guarded");
  await page.goto(siteUrl(a.host, "/dev/cache"));
  await expect(page.getByRole("heading", { name: "Cache spike (S1)" })).toHaveCount(0);
  await expect(page.getByTestId("path")).toHaveText("/dev/cache"); // just a site path

  const api = await page.goto(siteUrl(a.host, "/api/health"));
  expect(api?.headers()["content-type"]).toContain("text/html"); // the site, not the JSON endpoint

  await page.goto(siteUrl(a.host));
  const status = await page.evaluate(() =>
    fetch("/", { method: "POST", headers: { "Next-Action": "7f0000000000000000000000000000000000000000" }, body: "[]" }).then(
      (r) => r.status,
    ),
  );
  expect(status).toBe(404);
});

test("every response carries a request id", async ({ page }) => {
  const a = await seedSite("reqid", "x");
  for (const url of [siteUrl(a.host), "/", "/api/health"]) {
    const res = await page.goto(url);
    // A UUIDv7 locally; Vercel's own id (x-vercel-id) on deployments.
    expect(res?.headers()["x-request-id"], url).toMatch(/^[A-Za-z0-9:._-]{8,128}$/);
  }
});

test("outside production, ?__host= renders a tenant on the app host", async ({ page }) => {
  const a = await seedSite("override", "Overridden");
  await page.goto(`/?__host=${a.host}`);
  await expect(tagline(page)).toHaveText("Overridden");
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
  await site.goto(siteUrl(a.host));
  await expect(tagline(site)).toHaveText("Before");
  const bRenderedAt = await renderedAt(site, b);

  await page.goto("/dev/cache");
  const row = page.locator(`li[data-host="${a.host}"]`);
  await row.getByRole("textbox").fill("After action");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined),
    row.getByRole("button", { name: "Publish" }).click(),
  ]);

  await site.goto(siteUrl(a.host));
  await expect(tagline(site)).toHaveText("After action");
  expect(await renderedAt(site, b)).toBe(bRenderedAt); // B's cache entry survived
});

test("job-style route handler (revalidateTag, expire: 0): fresh on the very next request", async ({ page, request }) => {
  const a = await seedSite("job", "Before");
  await page.goto(siteUrl(a.host));
  await expect(tagline(page)).toHaveText("Before");

  const res = await request.post("/api/dev/revalidate", {
    data: { orgId: a.orgId, siteId: a.siteId, tagline: "After job" },
    headers: cronAuth,
  });
  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ ok: true, flushed: { immediate: [`site:${a.siteId}:config`], stale: [] } });

  await page.goto(siteUrl(a.host));
  await expect(tagline(page)).toHaveText("After job");
});
