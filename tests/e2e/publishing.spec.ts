import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { asUniqueVisitor } from "./helpers/auth";
import { auditOf, markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf, type Role } from "./helpers/site-ui";
import { addMember, publicView, seedUser, setSiteWithoutInvalidation } from "./helpers/sites";

/**
 * M4-5 end to end against the production build: publishing a site through
 * its overview, what the public address shows before and after (theme, SEO,
 * no analytics), the way back to Coming soon, and who may not.
 */

const tail = () => randomBytes(3).toString("hex");
const shown = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const robots = (page: Page) => page.locator('meta[name="robots"]').evaluateAll((elements) => elements.map((element) => element.getAttribute("content")));
const trackers = (page: Page) => page.locator('script[src*="googletagmanager"], script[src*="plausible"], script#forge-ga4, script#forge-plausible');
const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A verified member with this role, and a site an Owner made through the form, on its overview. */
async function withSite(page: Page, role: Role = "owner", options: { verified?: boolean } = {}) {
  const org = await seedOrganization("publish");
  // Someone else owns it, so this member can be given any role.
  await addMember(org.id, (await seedUser()).email, "owner");
  const member = await memberOf(page, "owner", org);
  if (options.verified ?? true) await markEmailVerified(member.email);
  const address = `publish-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  if (role !== "owner") await addMember(org.id, member.email, role);
  const [site] = await sitesIn(org.id);
  const overview = `/${org.slug}/sites/${site!.slug}`;
  if (role !== "owner") await page.goto(overview);
  return { ...member, org, address, siteId: site!.id, overview, site: { orgId: org.id, siteId: site!.id, address, name: "Harbour Bakery" } };
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("an Owner publishes: asked first with the real public URL; then live in the admin, the database, the log and on the same public address", async ({ page, baseURL }) => {
  // Nothing ever leaves for Google or Plausible: any such request is recorded and refused.
  const tracking: string[] = [];
  await page.context().route(/googletagmanager\.com|google-analytics\.com|plausible\.io/, (route) => {
    tracking.push(route.request().url());
    return route.abort();
  });
  const { org, address, overview, site } = await withSite(page);
  const publicUrl = `${baseURL}/s/${address}`;

  // 2. The overview: Coming soon, and the full public address.
  await expect(shown(page, "site-status")).toHaveText("Coming soon");
  await expect(shown(page, "status-explanation")).toContainText("Visitors see a Coming soon page");
  await expect(shown(page, "site-address")).toHaveText(publicUrl);
  await expect(shown(page, "site-address")).toHaveAttribute("href", publicUrl);
  await expect(shown(page, "checklist-item").filter({ hasText: "Publish your site" })).toContainText("When you publish, visitors see your site instead of the Coming soon page.");

  // 3. The public site: the theme's Coming soon page, not to be indexed. (Also puts it in the cache that publishing must flush.)
  expect((await page.goto(`/s/${address}`))!.status()).toBe(200);
  expect(await publicView(page)).toMatchObject({ heading: "Harbour Bakery", theme: "studio" });
  await expect(page.getByRole("main")).toContainText("Coming soon");
  expect(await robots(page)).toEqual(["noindex, nofollow"]);
  await expect(trackers(page)).toHaveCount(0);

  // 4. Publish, by keyboard: the button opens the confirmation; Escape leaves it with nothing changed.
  await page.goto(overview);
  const open = page.getByRole("button", { name: "Publish site…" });
  await open.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Publish Harbour Bakery?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`The site goes from Coming soon to live at ${publicUrl}.`);
  await expect(dialog.getByTestId("publish-url")).toHaveText(publicUrl);
  await expect(dialog).toContainText("For now, your site’s home page shows its name and tagline in its theme. Adding pages and posts is not available yet.");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  expect((await sitesIn(org.id))[0]!.status).toBe("coming_soon");

  await open.click();
  await dialog.getByRole("button", { name: "Publish site" }).click();

  // 5. Live, once the server said so: the message, the link to the public site, the badge, the checklist.
  const done = page.locator('[data-form-alert][role="status"]').filter({ visible: true });
  await expect(done).toContainText("Harbour Bakery is live.");
  await expect(done).toBeFocused();
  await expect(shown(page, "published-link")).toHaveAttribute("href", publicUrl);
  await expect(dialog).toBeHidden();
  await expect(shown(page, "site-status")).toHaveText("Live");
  await expect(shown(page, "status-explanation")).toContainText("visitors see its home page, and search engines may list it");
  await expect(shown(page, "checklist-item").filter({ hasText: "Publish your site" })).toHaveAttribute("data-done", "");
  await expect(page.getByRole("button", { name: "Switch to Coming soon…" })).toBeVisible();
  expect((await sitesIn(org.id))[0]).toMatchObject({ status: "live", address });
  expect((await auditOf(org.id)).filter((event) => event.action === "site.status_changed")).toEqual([
    expect.objectContaining({ resource_type: "site", metadata: { name: "Harbour Bakery", previousStatus: "coming_soon", newStatus: "live" } }),
  ]);
  await page.reload();
  await expect(shown(page, "site-status")).toHaveText("Live");
  await expect(shown(page, "site-activity")).toContainText("published the site Harbour Bakery.");

  // 6–8. The same public URL: the live home page, through the site's theme, indexable; no Coming soon, no tracking, nothing internal.
  await shown(page, "view-site").click();
  await expect(page).toHaveURL(publicUrl);
  expect(await publicView(page)).toMatchObject({ heading: "Harbour Bakery", theme: "studio" });
  await expect(page.getByRole("main")).not.toContainText("Coming soon");
  expect(await robots(page)).toEqual(["index, follow"]);
  await expect(page).toHaveTitle("Harbour Bakery");
  const html = await page.content();
  for (const leak of [site.orgId, site.siteId, org.slug, "data cached at", 'data-testid="rendered-at"']) expect(html, leak).not.toContain(leak);
  await expect(trackers(page)).toHaveCount(0);
  expect(tracking).toEqual([]);
});

test("back to Coming soon: asked first, the same address, and the public site is a Coming soon page again, not indexed", async ({ page, baseURL }) => {
  const { org, address, overview } = await withSite(page);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(shown(page, "site-status")).toHaveText("Live");
  await page.goto(`/s/${address}`);
  expect(await robots(page)).toEqual(["index, follow"]);

  await page.goto(overview);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByRole("button", { name: "Switch to Coming soon…" }).click();
  const dialog = page.getByRole("dialog", { name: "Switch Harbour Bakery back to Coming soon?" });
  await expect(dialog).toContainText(`Visitors to ${baseURL}/s/${address} see the Coming soon page again. The address stays the same.`);
  expect(await sidewaysScroll(page)).toBe(0);
  await dialog.getByRole("button", { name: "Switch to Coming soon" }).click();
  await expect(page.locator('[data-form-alert][role="status"]').filter({ visible: true })).toContainText("Harbour Bakery shows the Coming soon page again.");
  await expect(shown(page, "site-status")).toHaveText("Coming soon");
  expect((await auditOf(org.id)).filter((event) => event.action === "site.status_changed").map((event) => event.metadata.newStatus)).toEqual(["live", "coming_soon"]);

  await page.goto(`/s/${address}`);
  await expect(page.getByRole("main")).toContainText("Coming soon");
  expect(await robots(page)).toEqual(["noindex, nofollow"]);
});

test("publishing waits for a verified email address; once verified, the button is there", async ({ page }) => {
  const { email, org } = await withSite(page, "owner", { verified: false });
  await expect(shown(page, "publish-needs-verification")).toContainText("Verify your email address to publish this site.");
  await expect(page.getByRole("button", { name: "Publish site…" })).toHaveCount(0);
  await markEmailVerified(email);
  await page.reload();
  await expect(page.getByRole("button", { name: "Publish site…" })).toBeVisible();
  expect((await sitesIn(org.id))[0]!.status).toBe("coming_soon");
});

test("an Editor sees the status but no way to publish; an Admin demoted while the dialog is open is refused by the server", async ({ page }) => {
  const editor = await withSite(page, "editor");
  await expect(shown(page, "site-status")).toHaveText("Coming soon");
  await expect(page.getByRole("button", { name: /Publish site/ })).toHaveCount(0);
  await expect(shown(page, "site-publishing")).toHaveCount(0);
  await expect(shown(page, "checklist-item").filter({ hasText: "Publish your site" }).getByRole("link")).toHaveCount(0);

  // The button is not the boundary: an Admin opens the dialog, loses the permission, and confirms.
  await addMember(editor.org.id, editor.email, "admin");
  await page.reload();
  await page.getByRole("button", { name: "Publish site…" }).click();
  await addMember(editor.org.id, editor.email, "editor");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Publish site" }).click();
  await expect(dialog.locator('[data-form-alert][role="alert"]')).toContainText("You don't have permission to do that.");
  expect((await sitesIn(editor.org.id))[0]!.status).toBe("coming_soon");
  expect((await auditOf(editor.org.id)).filter((event) => event.action === "site.status_changed")).toEqual([]);
});

test("a site suspended while the dialog is open: the server refuses, nothing changes, and the overview then offers nothing", async ({ page }) => {
  const { org, address, site } = await withSite(page);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await setSiteWithoutInvalidation(site, { status: "suspended" });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Publish site" }).click();
  await expect(dialog.locator('[data-form-alert][role="alert"]')).toContainText("This site is unavailable, so its status cannot be changed here. Contact Forge support.");
  expect((await sitesIn(org.id))[0]!.status).toBe("suspended");
  expect((await auditOf(org.id)).filter((event) => event.action === "site.status_changed")).toEqual([]);

  await page.reload();
  await expect(shown(page, "site-status")).toHaveText("Suspended");
  await expect(shown(page, "site-publishing")).toHaveCount(0);
  const response = (await page.goto(`/s/${address}`))!;
  expect(response.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This site is unavailable");
});

test("another organization's site cannot be opened, so cannot be published, from either organization's URL", async ({ page, browser }) => {
  const theirs = await withSite(page);
  const context = await browser.newContext();
  const other = await context.newPage();
  await asUniqueVisitor(other);
  const mine = await memberOf(other);
  await markEmailVerified(mine.email);
  const slug = theirs.overview.split("/").at(-1)!;
  for (const url of [theirs.overview, `/${mine.org.slug}/sites/${slug}`, `/${mine.org.slug}/sites/${theirs.siteId}`]) {
    await other.goto(url);
    await expect(shown(other, "not-found"), url).toBeVisible();
    await expect(other.getByRole("button", { name: /Publish site/ })).toHaveCount(0);
  }
  await context.close();
  expect((await sitesIn(theirs.org.id))[0]!.status).toBe("coming_soon");
});
