import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { asUniqueVisitor, landing, newEmail, signUp } from "./helpers/auth";
import { organizationsOf, sitesIn, themeOf } from "./helpers/orgs";
import { createForm, createSite } from "./helpers/site-ui";

/**
 * Onboarding's steps 2 and 3 (M4-2) end to end: organization → site → theme,
 * with the forms and actions of the admin's own screens, resumable from what
 * already exists, and usable on a phone.
 */

const tail = () => randomBytes(3).toString("hex");
// Next keeps the step a redirect left in the document, hidden: the visible one is the current step.
const step = (page: Page) => page.getByTestId("onboarding-step").filter({ visible: true });
const picker = (page: Page) => page.getByRole("form", { name: "Theme" });
const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("a new account: organization → site → theme, resumed after a refresh and after leaving, ending on the site", async ({ page, baseURL }) => {
  const email = newEmail();
  await signUp(page, email);
  await page.goto("/onboarding");
  await expect(landing(page)).toBeVisible();
  await expect(step(page)).toHaveText("Step 1 of 3");

  const slug = `onboard-${tail()}`;
  await page.getByLabel("Organization name").fill("Onboarded Studio");
  await page.getByLabel("URL").fill(slug);
  await page.getByRole("button", { name: "Create organization" }).click();

  // Step 2: the organization's first site. A refresh, or leaving and coming back to /onboarding, lands here again.
  await expect(page).toHaveURL(`${baseURL}/onboarding/${slug}`);
  await expect(step(page)).toHaveText("Step 2 of 3");
  await page.reload();
  await expect(step(page)).toHaveText("Step 2 of 3");
  await page.goto("/account");
  await page.goto("/onboarding");
  await expect(page).toHaveURL(`${baseURL}/onboarding/${slug}`);

  const address = `first-${tail()}`;
  await createSite(page, { name: "First Site", address, language: "Filipino" });
  await expect(page).toHaveURL(`${baseURL}/onboarding/${slug}/${address}`, { timeout: 15_000 });

  // Step 3: the registry's themes, through the same picker and action as the Appearance page.
  await expect(step(page)).toHaveText("Step 3 of 3");
  await expect(picker(page).locator('[data-testid="theme-option"]')).toHaveCount(2);
  await expect(picker(page).locator('[data-theme-key="studio"]').getByTestId("current-theme")).toBeVisible();
  await page.reload();
  await expect(step(page)).toHaveText("Step 3 of 3");
  await picker(page).locator('[data-theme-key="journal"]').click();
  await picker(page).getByRole("button", { name: "Use this theme" }).click();
  await expect(page.locator('[data-form-alert][role="status"]').filter({ visible: true })).toHaveText("The site now uses Journal.");

  await page.getByRole("link", { name: "Continue to your site" }).click();
  await expect(page).toHaveURL(`${baseURL}/${slug}/sites/${address}`);
  await expect(page.getByTestId("site-theme").filter({ visible: true })).toHaveText("Journal");

  const [organization] = await organizationsOf(email);
  const sites = await sitesIn(organization!.id);
  expect(sites).toEqual([expect.objectContaining({ name: "First Site", slug: address, address, default_locale: "fil", status: "coming_soon" })]);
  expect(await themeOf(organization!.id, sites[0]!.id)).toBe("journal");

  // Onboarding is over: /onboarding now leads to the organization's sites.
  await page.goto("/onboarding");
  await expect(page).toHaveURL(`${baseURL}/${slug}/sites`);
});

test("step 2 refuses what the create-site form refuses, and keeps what was typed", async ({ page, baseURL }) => {
  await signUp(page, newEmail());
  await page.goto("/onboarding");
  const slug = `refuse-${tail()}`;
  await page.getByLabel("Organization name").fill("Refusing");
  await page.getByLabel("URL").fill(slug);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(`${baseURL}/onboarding/${slug}`);

  await createSite(page, { name: "Kept Name", address: "www" });
  await expect(createForm(page).getByText("That address is reserved. Choose another.")).toBeVisible();
  await expect(createForm(page).getByLabel("Site name")).toHaveValue("Kept Name");
  await expect(page).toHaveURL(`${baseURL}/onboarding/${slug}`);
});

test("on a phone (360 px): every step fits, and the whole way works", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await signUp(page, newEmail());
  await page.goto("/onboarding");
  expect(await sidewaysScroll(page)).toBe(0);
  const slug = `phone-${tail()}`;
  await page.getByLabel("Organization name").fill("A Phone Organization");
  await page.getByLabel("URL").fill(slug);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(`${baseURL}/onboarding/${slug}`);
  expect(await sidewaysScroll(page)).toBe(0);
  const address = `phone-site-${tail()}`;
  await createSite(page, { name: "A Phone Site", address });
  await expect(page).toHaveURL(`${baseURL}/onboarding/${slug}/${address}`, { timeout: 15_000 });
  expect(await sidewaysScroll(page)).toBe(0);
  await page.getByRole("link", { name: "Continue to your site" }).click();
  await expect(page).toHaveURL(`${baseURL}/${slug}/sites/${address}`);
  expect(await sidewaysScroll(page)).toBe(0);
});
