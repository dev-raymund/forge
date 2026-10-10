import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { asUniqueVisitor } from "./helpers/auth";
import { auditOf, seedOrganization, setPlan, sitesIn } from "./helpers/orgs";
import { createForm, createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, seedUser } from "./helpers/sites";

/**
 * M4-1 end to end against the production build: the sites page, creating a
 * site, its public address at `/s/{address}`, a taken address, who may create
 * sites, another organization's site, moving and deleting a site, the plan's
 * limit, and a phone.
 */

const tail = () => randomBytes(3).toString("hex");
// Next keeps the page it left in the document, hidden: these look at what is on screen only.
const shown = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const orgNav = (page: Page) => page.getByRole("navigation", { name: "Organization" });
const formStatus = (page: Page) => page.locator('[data-form-alert][role="status"]').filter({ visible: true });
const createSiteLink = (page: Page) => page.getByRole("main").getByRole("link", { name: "Create site" });
const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("an Owner creates the first site: sites page → create → its page → in the list → its public address shows it", async ({ page, baseURL }) => {
  const { org } = await memberOf(page);

  // `/` and `/{orgSlug}` both lead to the organization's sites, which has none yet.
  await page.goto("/");
  await expect(page).toHaveURL(`${baseURL}/${org.slug}/sites`);
  await page.goto(`/${org.slug}`);
  await expect(page).toHaveURL(`${baseURL}/${org.slug}/sites`);
  await expect(page.getByRole("heading", { level: 1, name: "Sites" })).toBeVisible();
  await expect(orgNav(page).getByRole("link", { name: "Sites" })).toHaveAttribute("aria-current", "page");
  await expect(shown(page, "no-sites")).toContainText("No sites yet");
  await expect(shown(page, "site-allowance")).toHaveText("0 of 5 sites on the Pro plan.");

  await createSiteLink(page).click();
  await expect(page).toHaveURL(`${baseURL}/${org.slug}/sites/new`);
  // The address follows the name until it is typed in; the hint says where the site will be.
  const form = createForm(page);
  await form.getByLabel("Site name").fill("Corner Bakery & Café");
  await expect(form.getByLabel("Site address")).toHaveValue("corner-bakery-and-cafe");
  await expect(form.getByText("Your site will be at /s/corner-bakery-and-cafe")).toBeVisible();

  const address = `bakery-${tail()}`;
  await createSite(page, { name: "Corner Bakery", address: ` ${address.toUpperCase()} `, language: "Filipino", timezone: "Asia/Manila" });

  // The new site's page: its name, Coming soon, and where the public sees it.
  await expectSiteCreated(page, org.slug, address);
  await expect(page).toHaveURL(`${baseURL}/${org.slug}/sites/${address}`);
  await expect(shown(page, "site-name")).toHaveText("Corner Bakery");
  await expect(shown(page, "site-status")).toHaveText("Coming soon");
  await expect(shown(page, "site-address")).toHaveText(`${baseURL}/s/${address}`);
  await expect(shown(page, "site-language")).toHaveText("Filipino");
  await expect(shown(page, "site-timezone")).toHaveText("Asia/Manila");
  expect(await sitesIn(org.id)).toEqual([
    { id: expect.any(String), name: "Corner Bakery", slug: address, status: "coming_soon", default_locale: "fil", timezone: "Asia/Manila", deleted: false, address },
  ]);
  expect((await auditOf(org.id)).at(-1)).toMatchObject({ action: "site.created", resource_type: "site", metadata: { name: "Corner Bakery", address } });

  // In the list.
  await orgNav(page).getByRole("link", { name: "Sites" }).click();
  await expect(shown(page, "site")).toHaveCount(1);
  await expect(shown(page, "site")).toContainText("Corner Bakery");
  await expect(shown(page, "site-allowance")).toHaveText("1 of 5 sites on the Pro plan.");

  // And in the activity log.
  await page.goto(`/${org.slug}/activity`);
  await expect(page.getByTestId("event").first()).toContainText(`created the site Corner Bakery at /s/${address}.`);

  // Its public address shows it.
  await page.goto(`/${org.slug}/sites`);
  await shown(page, "site-address").click();
  await expect(page).toHaveURL(`${baseURL}/s/${address}`);
  // Drawn by its theme (M4-3): coming soon, with its name.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Corner Bakery");
  await expect(page.locator('[data-forge-theme][data-theme="studio"]')).toHaveCount(1);
});

test("the public site is the same for everyone, signed in or not, and an unknown address is a 404", async ({ page, browser }) => {
  const { org } = await memberOf(page);
  const address = `public-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Open House", address });
  await expectSiteCreated(page, org.slug, address);
  await expect(shown(page, "site-name")).toHaveText("Open House");

  // The member who made it, a signed-in member of another organization, and someone signed out.
  const [elsewhere, stranger] = [await browser.newContext(), await browser.newContext()];
  const [otherMember, anonymous] = [await elsewhere.newPage(), await stranger.newPage()];
  await asUniqueVisitor(otherMember);
  await asUniqueVisitor(anonymous);
  await memberOf(otherMember);

  for (const visitor of [page, otherMember, anonymous]) {
    const response = (await visitor.goto(`/s/${address}`))!;
    expect(response.status()).toBe(200);
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Open House");
    await expect(visitor.getByRole("banner").getByRole("link", { name: "Open House" })).toHaveAttribute("href", `/s/${address}`);
  }
  const unknown = (await anonymous.goto(`/s/nobody-${tail()}`))!;
  expect(unknown.status()).toBe(404);
  await Promise.all([elsewhere.close(), stranger.close()]);
});

test("an address someone else has: a friendly error at the field, what was typed kept, and their site untouched", async ({ page, browser }) => {
  const first = await memberOf(page);
  const address = `taken-${tail()}`;
  await page.goto(`/${first.org.slug}/sites/new`);
  await createSite(page, { name: "The Original", address });
  await expectSiteCreated(page, first.org.slug, address);
  await expect(shown(page, "site-name")).toHaveText("The Original");

  const second = await browser.newContext();
  const other = await second.newPage();
  await asUniqueVisitor(other);
  const { org } = await memberOf(other);
  await other.goto(`/${org.slug}/sites/new`);
  await createSite(other, { name: "The Copy", address: address.toUpperCase() });
  const field = createForm(other).getByLabel("Site address");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(createForm(other).getByText("That address is already taken. Choose another.")).toBeVisible();
  await expect(field).toBeFocused();
  await expect(createForm(other).getByLabel("Site name")).toHaveValue("The Copy");
  await expect(other).toHaveURL(new RegExp(`/${org.slug}/sites/new$`));
  expect(await sitesIn(org.id)).toEqual([]);

  // Reserved and malformed addresses are caught before anything is sent.
  const refusals: [string, string][] = [
    ["www", "That address is reserved. Choose another."],
    ["my--site", "Use lowercase letters, numbers and single hyphens, not at the start or end, e.g. acme-studio."],
  ];
  for (const [typed, message] of refusals) {
    await field.fill(typed);
    await createForm(other).getByRole("button", { name: "Create site" }).click();
    await expect(createForm(other).getByText(message)).toBeVisible();
  }

  // The original is still the original, in public.
  await other.goto(`/s/${address}`);
  await expect(other.getByRole("heading", { level: 1 })).toHaveText("The Original");
  expect((await sitesIn(first.org.id)).map((site) => site.address)).toEqual([address]);
  await second.close();
});

test("an Editor sees the sites, and has no way to create one: no button, and the form's page says so", async ({ page, baseURL }) => {
  const org = await seedOrganization("editors");
  const owner = await seedUser();
  await addMember(org.id, owner.email, "owner");
  await memberOf(page, "editor", org);

  await page.goto(`/${org.slug}/sites`);
  await expect(shown(page, "member-role")).toHaveText("Editor");
  await expect(shown(page, "no-sites")).toContainText("An Owner or Admin of");
  await expect(createSiteLink(page)).toHaveCount(0);
  await expect(shown(page, "site-allowance")).toHaveCount(0);

  await page.goto(`/${org.slug}/sites/new`);
  await expect(page).toHaveURL(`${baseURL}/${org.slug}/sites/new`);
  await expect(shown(page, "no-access")).toContainText("Creating sites is for Owners and Admins");
  await expect(createForm(page)).toHaveCount(0);
});

test("another organization's site: its admin pages are a 404, from that organization's URL or one's own", async ({ page, browser }) => {
  const owner = await memberOf(page);
  const address = `private-${tail()}`;
  await page.goto(`/${owner.org.slug}/sites/new`);
  await createSite(page, { name: "Not Yours", address });
  await expectSiteCreated(page, owner.org.slug, address);
  await expect(shown(page, "site-name")).toHaveText("Not Yours");

  const context = await browser.newContext();
  const outsider = await context.newPage();
  await asUniqueVisitor(outsider);
  const theirs = await memberOf(outsider);
  for (const path of [`/${owner.org.slug}/sites/${address}`, `/${owner.org.slug}/sites/${address}/settings`, `/${theirs.org.slug}/sites/${address}`, `/${theirs.org.slug}/sites/${address}/settings`]) {
    await outsider.goto(path);
    await expect(shown(outsider, "not-found"), path).toBeVisible();
    expect(await outsider.content(), path).not.toContain("Not Yours");
  }
  await context.close();
});

test("an Admin moves the site to another address; the Owner deletes it, and its address shows nothing any more", async ({ page, browser, baseURL }) => {
  const owner = await memberOf(page);
  const [from, to] = [`before-${tail()}`, `after-${tail()}`];
  await page.goto(`/${owner.org.slug}/sites/new`);
  await createSite(page, { name: "Mover", address: from });
  await expectSiteCreated(page, owner.org.slug, from);
  await expect(shown(page, "site-name")).toHaveText("Mover");

  // An Admin: the site's settings have the address, and no way to delete it.
  const context = await browser.newContext();
  const adminPage = await context.newPage();
  await asUniqueVisitor(adminPage);
  await memberOf(adminPage, "admin", owner.org);
  await adminPage.goto(`/${owner.org.slug}/sites/${from}`);
  await adminPage.getByRole("navigation", { name: "Site: Mover" }).getByRole("link", { name: "Settings" }).click();
  await expect(adminPage).toHaveURL(`${baseURL}/${owner.org.slug}/sites/${from}/settings`);
  await expect(adminPage.getByRole("button", { name: "Delete site…" })).toHaveCount(0);
  const addressForm = adminPage.getByRole("form", { name: "Site address" });
  await addressForm.getByLabel("Address").fill(to);
  await addressForm.getByRole("button", { name: "Change address" }).click();
  await expect(formStatus(adminPage)).toHaveText(`The site is now at /s/${to}.`);
  await expect(addressForm.getByLabel("Address")).toHaveValue(to);
  await context.close();

  // The old address answers nothing; the new one is the site. Its admin URL did not change.
  expect((await page.goto(`/s/${from}`))!.status()).toBe(404);
  await page.goto(`/s/${to}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mover");

  // The Owner deletes it, typing its address to confirm.
  await page.goto(`/${owner.org.slug}/sites/${from}/settings`);
  await page.getByRole("button", { name: "Delete site…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(`Type ${to} to confirm`).fill("not it");
  await dialog.getByRole("button", { name: "Delete site" }).click();
  await expect(dialog.getByText(`Type ${to} to confirm.`)).toBeVisible();
  await dialog.getByLabel(`Type ${to} to confirm`).fill(to);
  await dialog.getByRole("button", { name: "Delete site" }).click();

  await expect(page).toHaveURL(`${baseURL}/${owner.org.slug}/sites?done=deleted`);
  await expect(formStatus(page)).toContainText("The site has been deleted.");
  await expect(shown(page, "no-sites")).toBeVisible();
  expect((await page.goto(`/s/${to}`))!.status()).toBe(404);
  expect(await sitesIn(owner.org.id)).toEqual([expect.objectContaining({ name: "Mover", deleted: true, address: null })]);
  expect((await auditOf(owner.org.id)).map((row) => row.action).filter((action) => action.startsWith("site."))).toEqual(["site.created", "site.address_changed", "site.deleted"]);
});

test("the plan's limit: on the Free plan, one site, and then no way to create another", async ({ page }) => {
  const { org } = await memberOf(page);
  await setPlan(org.id, "free");
  await page.goto(`/${org.slug}/sites`);
  await expect(shown(page, "site-allowance")).toHaveText("0 of 1 site on the Free plan.");
  await createSiteLink(page).click();
  const only = `only-${tail()}`;
  await createSite(page, { name: "Only One", address: only });
  await expectSiteCreated(page, org.slug, only);
  await expect(shown(page, "site-name")).toHaveText("Only One");

  await page.goto(`/${org.slug}/sites`);
  await expect(shown(page, "site-allowance")).toHaveText("The Free plan includes 1 site, and this organization has reached it.");
  await expect(createSiteLink(page)).toHaveCount(0);
  await page.goto(`/${org.slug}/sites/new`);
  await expect(shown(page, "site-limit")).toContainText("The Free plan includes 1 site");
  await expect(createForm(page)).toHaveCount(0);
});

test("on a phone (360 px): the sites page and the create-site form fit, and work", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const { org } = await memberOf(page);
  await page.goto(`/${org.slug}/sites`);
  expect(await sidewaysScroll(page)).toBe(0);
  await createSiteLink(page).click();
  await expect(createForm(page)).toBeVisible();
  expect(await sidewaysScroll(page)).toBe(0);
  const address = `phone-${tail()}`;
  await createSite(page, { name: "A rather long name for a small bakery on a small screen", address, timezone: "Asia/Manila" });
  await expectSiteCreated(page, org.slug, address);
  await expect(page).toHaveURL(`${baseURL}/${org.slug}/sites/${address}`);
  expect(await sidewaysScroll(page)).toBe(0);
  await page.goto(`/${org.slug}/sites`);
  await expect(shown(page, "site")).toHaveCount(1);
  expect(await sidewaysScroll(page)).toBe(0);
});
