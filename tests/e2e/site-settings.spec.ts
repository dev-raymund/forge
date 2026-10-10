import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { asUniqueVisitor } from "./helpers/auth";
import { seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, seedUser, setSiteWithoutInvalidation } from "./helpers/sites";

/**
 * M4-2 end to end against the production build: a site's overview, its
 * general, reading and analytics settings, what the public site then shows,
 * who may change them, and a phone.
 */

const tail = () => randomBytes(3).toString("hex");
const shown = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const formStatus = (page: Page) => page.locator('[data-form-alert][role="status"]').filter({ visible: true });
const section = (page: Page, name: string) => page.getByRole("form", { name });
const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** An Owner with a new site, made through the form, on its overview. */
async function withSite(page: Page, name = "Settings Bakery") {
  const member = await memberOf(page);
  const address = `settings-${tail()}`;
  await page.goto(`/${member.org.slug}/sites/new`);
  await createSite(page, { name, address });
  await expectSiteCreated(page, member.org.slug, address);
  const [site] = await sitesIn(member.org.id);
  return { ...member, address, slug: site!.slug, siteId: site!.id, settings: `/${member.org.slug}/sites/${site!.slug}/settings` };
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("the overview says what the site is: status, public address, theme, setup, the launch checklist and its latest activity", async ({ page, baseURL }) => {
  const { address } = await withSite(page);
  await expect(shown(page, "site-name")).toHaveText("Settings Bakery");
  await expect(shown(page, "site-status")).toHaveText("Coming soon");
  await expect(shown(page, "status-explanation")).toContainText("Visitors see a Coming soon page");
  await expect(shown(page, "site-address")).toHaveAttribute("href", `${baseURL}/s/${address}`);
  await expect(shown(page, "site-theme")).toHaveText("Studio");
  await expect(shown(page, "site-analytics")).toHaveText("None");

  const checklist = shown(page, "checklist-item");
  await expect(checklist).toHaveCount(5);
  await expect(checklist.filter({ hasText: "Your site's address" })).toHaveAttribute("data-done", "");
  await expect(checklist.filter({ hasText: "Publish your site" })).not.toHaveAttribute("data-done", "");
  await expect(page.getByText("1 of 5 done.")).toBeVisible();
  await expect(shown(page, "site-activity")).toContainText(`created the site Settings Bakery at /s/${address}.`);

  // The public address is the real public site.
  await shown(page, "site-address").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings Bakery");
});

test("general settings: saved, still there after a reload, and the public site shows them", async ({ page }) => {
  const { address, settings } = await withSite(page);
  await page.goto(settings);
  const general = section(page, "General settings");
  await general.getByLabel("Site name").fill("Corner Bakery");
  await general.getByLabel("Tagline").fill("Fresh bread every morning");
  await general.getByLabel("Language").selectOption({ label: "Filipino" });
  await general.getByLabel("Time zone").selectOption("Asia/Manila");
  await general.getByLabel("Instagram").fill("https://instagram.com/cornerbakery");
  await general.getByRole("button", { name: "Save general settings" }).click();
  await expect(formStatus(page)).toContainText("General settings saved.");

  await page.reload();
  await expect(general.getByLabel("Site name")).toHaveValue("Corner Bakery");
  await expect(general.getByLabel("Tagline")).toHaveValue("Fresh bread every morning");
  await expect(general.getByLabel("Language")).toHaveValue("fil");
  await expect(general.getByLabel("Time zone")).toHaveValue("Asia/Manila");
  await expect(general.getByLabel("Instagram")).toHaveValue("https://instagram.com/cornerbakery");

  // A social link that is not an https address is refused at its field, and nothing is saved.
  await general.getByLabel("Facebook").fill("javascript:alert(1)");
  await general.getByRole("button", { name: "Save general settings" }).click();
  await expect(general.getByLabel("Facebook")).toHaveAttribute("aria-invalid", "true");

  // The public site, on the very next request.
  await page.goto(`/s/${address}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Corner Bakery");
  await expect(page.getByRole("main")).toContainText("Fresh bread every morning");
  await expect(page.locator("html")).toHaveAttribute("lang", "fil");
  await expect(page.getByRole("navigation", { name: "Social" }).getByRole("link", { name: "Instagram" })).toHaveAttribute("href", "https://instagram.com/cornerbakery");
});

test("reading settings: checked, saved, and said to take effect once there are posts", async ({ page }) => {
  const { settings, address } = await withSite(page);
  await page.goto(settings);
  const reading = section(page, "Reading settings");
  await expect(reading).toContainText("nothing on the site uses them");
  await reading.getByLabel("Blog path").fill("My Blog");
  await reading.getByRole("button", { name: "Save reading settings" }).click();
  await expect(reading.getByText("Use lowercase letters, numbers and single hyphens, like news or journal.")).toBeVisible();

  await reading.getByLabel("Blog path").fill("news");
  await reading.getByLabel("Posts per page").fill("12");
  await reading.getByRole("button", { name: "Save reading settings" }).click();
  await expect(formStatus(page)).toContainText("Reading settings saved.");
  await page.reload();
  await expect(reading.getByLabel("Blog path")).toHaveValue("news");
  await expect(reading.getByLabel("Posts per page")).toHaveValue("12");
  await expect(reading).toContainText(`Your posts will be at /s/${address}/news.`);
});

test("analytics: an invalid GA4 ID is refused; valid IDs are saved, and no page runs tracking, live or not, until consent is supported (M4-5)", async ({ page }) => {
  // Any request for Google's or Plausible's code is recorded and refused: there must be none.
  const tracking: string[] = [];
  await page.context().route(/googletagmanager\.com|google-analytics\.com|plausible\.io/, (route) => {
    tracking.push(route.request().url());
    return route.abort();
  });
  const { org, settings, address, siteId } = await withSite(page);
  await page.goto(settings);
  const analytics = section(page, "Analytics settings");
  await analytics.getByLabel("Google Analytics 4 measurement ID").fill("UA-12345-1");
  await analytics.getByRole("button", { name: "Save analytics settings" }).click();
  await expect(analytics.getByText("Use a GA4 measurement ID like G-ABC123XYZ9.")).toBeVisible();

  // The site is live, then the IDs are saved: the save refreshes the public site's settings.
  await setSiteWithoutInvalidation({ orgId: org.id, siteId, address, name: "" }, { status: "live" });
  await analytics.getByLabel("Google Analytics 4 measurement ID").fill("g-abc1234567");
  await analytics.getByLabel("Plausible domain").fill("Example.com");
  await analytics.getByRole("button", { name: "Save analytics settings" }).click();
  await expect(formStatus(page)).toContainText("Analytics settings saved.");
  await page.reload();
  await expect(analytics.getByLabel("Google Analytics 4 measurement ID")).toHaveValue("G-ABC1234567");
  await expect(analytics.getByLabel("Plausible domain")).toHaveValue("example.com");
  await expect(analytics.getByTestId("analytics-not-active")).toContainText("Tracking is not active yet");

  // A live site with both IDs saved: neither service's code, nor any of the IDs, is in the page; nothing is requested.
  await page.goto(`/s/${address}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator('script[src*="googletagmanager"], script[src*="plausible"], script#forge-ga4, script#forge-plausible')).toHaveCount(0);
  const html = await page.content();
  for (const id of ["G-ABC1234567", "UA-12345", "data-domain"]) expect(html, id).not.toContain(id);
  // The same while it is Coming soon.
  await setSiteWithoutInvalidation({ orgId: org.id, siteId, address, name: "" }, { status: "coming_soon" });
  await page.goto(settings);
  await analytics.getByLabel("Plausible domain").fill("example.org");
  await analytics.getByRole("button", { name: "Save analytics settings" }).click();
  await expect(formStatus(page)).toContainText("Analytics settings saved.");
  await page.goto(`/s/${address}`);
  await expect(page.getByRole("main")).toContainText("Coming soon");
  expect(await page.content()).not.toContain("G-ABC1234567");
  expect(tracking).toEqual([]);
});

test("a member who may not change settings: no links to them, and the page says so; another organization's site is a 404", async ({ page, browser }) => {
  const org = await seedOrganization("readers");
  const owner = await seedUser();
  await addMember(org.id, owner.email, "owner");
  await memberOf(page, "admin", org);
  const address = `readers-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Read Only", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);

  const context = await browser.newContext();
  const editor = await context.newPage();
  await asUniqueVisitor(editor);
  await memberOf(editor, "editor", org);
  await editor.goto(`/${org.slug}/sites/${site!.slug}`);
  await expect(shown(editor, "site-name")).toHaveText("Read Only");
  await expect(editor.getByRole("link", { name: /^Change/ })).toHaveCount(0);
  await expect(editor.getByRole("navigation", { name: "Site: Read Only" }).getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(editor.getByText("Recent activity")).toHaveCount(0);
  await editor.goto(`/${org.slug}/sites/${site!.slug}/settings`);
  await expect(shown(editor, "no-access")).toBeVisible();
  await expect(section(editor, "General settings")).toHaveCount(0);

  // Someone from elsewhere: the site's pages are a 404.
  const outsiderContext = await browser.newContext();
  const outsider = await outsiderContext.newPage();
  await asUniqueVisitor(outsider);
  await memberOf(outsider);
  for (const path of [`/${org.slug}/sites/${site!.slug}`, `/${org.slug}/sites/${site!.slug}/settings`]) {
    await outsider.goto(path);
    await expect(shown(outsider, "not-found"), path).toBeVisible();
  }
  await Promise.all([context.close(), outsiderContext.close()]);
});

test("on a phone (360 px): the overview and the settings fit, and saving works", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const { settings } = await withSite(page, "Small Bakery");
  expect(await sidewaysScroll(page)).toBe(0);
  await page.goto(settings);
  expect(await sidewaysScroll(page)).toBe(0);
  const reading = section(page, "Reading settings");
  await reading.getByLabel("Posts per page").fill("6");
  await reading.getByRole("button", { name: "Save reading settings" }).click();
  await expect(formStatus(page)).toContainText("Reading settings saved.");
  expect(await sidewaysScroll(page)).toBe(0);
});
