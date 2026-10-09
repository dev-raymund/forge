import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { asUniqueVisitor } from "./helpers/auth";
import { sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { publicView, seedSite, setSiteWithoutInvalidation, setTaglineWithoutInvalidation, type SeededSite } from "./helpers/sites";

/**
 * The public renderer (M4-3, ADR 0013) against a production build on ONE host,
 * like the V1 deployment: tenant sites at `/s/{address}/…`, drawn by their
 * theme, with real status codes. It also keeps every guarantee the M0-4 spike's
 * spec proved (routing guards, headers, caching), now on the real renderer.
 */

const tail = () => randomBytes(3).toString("hex");
const siteUrl = (site: SeededSite | string, path = "/") => `/s/${typeof site === "string" ? site : site.address}${path === "/" ? "" : path}`;
const robots = (page: Page) => page.locator('meta[name="robots"]').evaluateAll((elements) => elements.map((element) => element.getAttribute("content")));
const primaryColour = (page: Page) => page.locator("[data-forge-theme]").evaluate((element) => getComputedStyle(element).getPropertyValue("--forge-color-primary").trim());

/** Nothing of the M0-4 debug view, or of the site's private side, is in the page. */
async function expectNoDebugOrPrivateData(page: Page, site: SeededSite) {
  const html = await page.content();
  for (const leak of ['data-testid="path"', 'data-testid="base-path"', 'data-testid="rendered-at"', "data cached at", site.orgId, site.siteId, `org-${site.address}`]) {
    expect(html, leak).not.toContain(leak);
  }
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("a coming-soon site: its theme's coming-soon page at every path, noindex, and none of the old debug view", async ({ page }) => {
  const site = await seedSite("soon", "Fresh bread daily", { language: "fil" });
  for (const path of ["/", "/about", "/blog/example"]) {
    const response = (await page.goto(siteUrl(site, path)))!;
    expect(response.status(), path).toBe(200);
    expect(await publicView(page)).toMatchObject({ heading: site.name, theme: "studio" });
    await expect(page.getByRole("main")).toContainText("Fresh bread daily");
    await expect(page.getByRole("main")).toContainText("Coming soon");
    expect(await robots(page), path).toEqual(["noindex, nofollow"]);
    expect(await page.locator("html").getAttribute("lang")).toBe("fil");
    await expectNoDebugOrPrivateData(page, site);
  }
  // Its links are its own: the home link is the site's base.
  await expect(page.getByRole("banner").getByRole("link", { name: site.name })).toHaveAttribute("href", `/s/${site.address}`);
  await expect(page).toHaveTitle(site.name);
});

test("Studio and Journal each draw their own layout", async ({ page }) => {
  const [studio, journal] = await Promise.all([seedSite("stu", "Business first"), seedSite("jou", "Blog first", { theme: "journal" })]);
  await page.goto(siteUrl(studio));
  expect(await publicView(page)).toMatchObject({ theme: "studio", heading: studio.name });
  await expect(page.locator(".studio-header")).toBeVisible();
  expect(await primaryColour(page)).toBe("#1d4ed8");

  await page.goto(siteUrl(journal));
  expect(await publicView(page)).toMatchObject({ theme: "journal", heading: "Coming soon" });
  await expect(page.locator(".journal-header")).toContainText(journal.name);
  await expect(page.locator(".journal-header")).toContainText("Blog first");
  expect(await primaryColour(page)).toBe("#9a3412");
  for (const landmark of ["banner", "main", "contentinfo"] as const) await expect(page.getByRole(landmark)).toHaveCount(1);
});

test("a live site: its home page drawn by its theme and indexable; any other path a real 404 with the theme's not-found page", async ({ page }) => {
  const site = await seedSite("open", "Open every day", { status: "live", theme: "journal" });
  const home = (await page.goto(siteUrl(site)))!;
  expect(home.status()).toBe(200);
  expect(await publicView(page)).toMatchObject({ theme: "journal", heading: site.name });
  await expect(page.getByRole("main")).toContainText("Open every day");
  expect(await robots(page)).toEqual(["index, follow"]);

  for (const path of ["/about", "/contact", "/blog/example"]) {
    const missing = (await page.goto(siteUrl(site, path)))!;
    expect(missing.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    expect((await publicView(page)).theme, path).toBe("journal"); // inside the site's own theme
    await expect(page.getByRole("main").getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", `/s/${site.address}`);
    expect(await robots(page), path).toContain("noindex");
    await expectNoDebugOrPrivateData(page, site);
  }
});

test("a suspended site: 404, a neutral page, and nothing of the site: not its name, its words or its theme", async ({ page }) => {
  const site = await seedSite("held", "A tagline nobody should see", { status: "suspended", theme: "journal" });
  for (const path of ["/", "/about"]) {
    const response = (await page.goto(siteUrl(site, path)))!;
    expect(response.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This site is unavailable");
    await expect(page.locator("[data-forge-theme]")).toHaveCount(0);
    const html = await page.content();
    for (const leak of [site.name, "A tagline nobody should see", "suspend", "billing", "journal"]) expect(html.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    expect(await robots(page), path).toContain("noindex");
    await expectNoDebugOrPrivateData(page, site);
  }
});

test("an unknown or malformed address: a real 404, the platform's page, the same as for any other address", async ({ page }) => {
  for (const url of [siteUrl(`nobody-${tail()}`), siteUrl(`nobody-${tail()}`, "/anything"), "/s/Not_A_Site", "/s"]) {
    const response = (await page.goto(url))!;
    expect(response.status(), url).toBe(404);
  }
  await page.goto(siteUrl(`nobody-${tail()}`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Site not found");
  await expect(page.locator("[data-forge-theme]")).toHaveCount(0);
  expect(await robots(page)).toContain("noindex");
});

test("routing guards: /render is internal, a site path is never the admin's, the API's or a Server Action's", async ({ page }) => {
  const site = await seedSite("guard", "Guarded");
  expect((await page.goto(`/render/address~${site.address}`))?.status()).toBe(404);
  expect((await page.goto(siteUrl(site, `/render/address~${site.address}`)))?.status()).toBe(200); // just a path inside the site

  await page.goto(siteUrl(site, "/dev/editor"));
  expect(await publicView(page)).toMatchObject({ heading: site.name, theme: "studio" });
  const api = await page.goto(siteUrl(site, "/api/health"));
  expect(api?.headers()["content-type"]).toContain("text/html"); // the site, not the JSON endpoint

  await page.goto(siteUrl(site));
  const status = await page.evaluate(
    (url) => fetch(url, { method: "POST", headers: { "Next-Action": "7f0000000000000000000000000000000000000000" }, body: "[]" }).then((r) => r.status),
    siteUrl(site, "/about"),
  );
  expect(status).toBe(404);
  await expect(page.locator("form")).toHaveCount(0); // a public page has nothing to submit
});

test("headers: framed only by the same origin, a request id, and no cookie set", async ({ page }) => {
  const site = await seedSite("hdr", "x");
  const response = (await page.goto(siteUrl(site)))!;
  expect(response.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(response.headers()["set-cookie"]).toBeUndefined();
  expect(response.headers()["x-request-id"]).toMatch(/^[A-Za-z0-9:._-]{8,128}$/);
  const missing = (await page.goto(siteUrl(`nobody-${tail()}`)))!;
  expect(missing.headers()["set-cookie"]).toBeUndefined();
});

test("public data is cached: changes made behind the app's back do not show", async ({ page }) => {
  const site = await seedSite("cached", "Original");
  await page.goto(siteUrl(site));
  await expect(page.getByRole("main")).toContainText("Original");
  await setTaglineWithoutInvalidation(site, "Sneaky");
  await setSiteWithoutInvalidation(site, { theme: "journal" });
  await page.reload();
  await expect(page.getByRole("main")).toContainText("Original");
  expect((await publicView(page)).theme).toBe("studio");
});

test("a theme switch in the admin shows on the very next public request; another site's cached page is untouched", async ({ page, browser }) => {
  const bystander = await seedSite("bystander", "Unchanged");
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(siteUrl(bystander));
  await expect(visitor.getByRole("main")).toContainText("Unchanged");
  await setTaglineWithoutInvalidation(bystander, "Should not show");

  const { org } = await memberOf(page);
  const address = `switch-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Switcher", address });
  await expectSiteCreated(page, org.slug, address);
  await visitor.goto(siteUrl(address));
  expect((await publicView(visitor)).theme).toBe("studio");

  const [created] = await sitesIn(org.id);
  await page.goto(`/${org.slug}/sites/${created!.slug}/appearance`);
  await page.getByRole("form", { name: "Theme" }).locator('[data-theme-key="journal"]').click();
  await page.getByRole("button", { name: "Use this theme" }).click();
  await expect(page.locator('[data-form-alert][role="status"]').filter({ visible: true })).toHaveText("The site now uses Journal.");

  await visitor.goto(siteUrl(address));
  expect((await publicView(visitor)).theme).toBe("journal");
  await visitor.goto(siteUrl(bystander));
  await expect(visitor.getByRole("main")).toContainText("Unchanged"); // its cache entry survived
  await visitorContext.close();
});

test("two sites' branding never mixes: each page has its own colours and theme", async ({ page }) => {
  const [red, green] = await Promise.all([
    seedSite("red", "Red", { themeSettings: { tokens: { colors: { primary: "#b91c1c" } } } }),
    seedSite("green", "Green", { theme: "journal", themeSettings: { tokens: { colors: { primary: "#15803d" } } } }),
  ]);
  for (let round = 0; round < 2; round++) {
    await page.goto(siteUrl(red));
    expect([await primaryColour(page), (await publicView(page)).theme]).toEqual(["#b91c1c", "studio"]);
    await page.goto(siteUrl(green));
    expect([await primaryColour(page), (await publicView(page)).theme]).toEqual(["#15803d", "journal"]);
  }
});
