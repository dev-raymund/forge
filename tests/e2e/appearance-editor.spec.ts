import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { asUniqueVisitor } from "./helpers/auth";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, seedUser } from "./helpers/sites";

/**
 * M8-1 end to end against the production build: the appearance editor (colours with the contrast warning, fonts,
 * header, footer, layout), its live preview of what is not saved (visitors still see the saved appearance), saving
 * (the live site updated), discarding, a value refused, a phone, and who may.
 */

test.describe.configure({ timeout: 120_000 });

const tail = () => randomBytes(3).toString("hex");
const form = (page: Page) => page.getByTestId("appearance-form");
const preview = (page: Page) => page.frameLocator('[data-testid="appearance-preview-frame"]');
const notice = (page: Page) => form(page).locator('[data-form-alert]');

async function withLiveSite(page: Page) {
  const org = await seedOrganization("look");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `look-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  await page.goto(base);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Live", { timeout: 15_000 });
  return { org, base, address, member };
}

/** The theme root's style on a page: the CSS variables the site's settings produce. */
const rootStyle = (scope: Page | ReturnType<typeof preview>) => scope.locator("[data-forge-theme]").getAttribute("style");

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("customise the appearance: the contrast warning, the live preview of unsaved changes, then save and the live site shows them", async ({ page, browser }) => {
  const { base, address } = await withLiveSite(page);
  await page.goto(`${base}/appearance`);
  await expect(page.getByRole("heading", { name: "Customise Studio" })).toBeVisible();
  await expect(preview(page).getByTestId("preview-banner")).toContainText("Preview of your appearance changes", { timeout: 15_000 });

  // A poor text colour is warned about (not refused); a good one clears the warning.
  await page.locator("#color-text").fill("#9ca3af");
  await expect(form(page).getByTestId("contrast-warning")).toHaveText(/^The text colour on the background has a contrast of 2\.54:1/);
  await page.locator("#color-text").fill("#1c1917");
  await expect(form(page).getByTestId("contrast-warning")).toHaveCount(0);

  await page.locator("#color-primary").fill("#be123c");
  await form(page).getByLabel("Headings", { exact: true }).selectOption({ label: "Playfair Display" });
  await form(page).getByRole("radio", { name: /^Centred/ }).check();
  await form(page).getByRole("checkbox", { name: "Show a button (a call to action)" }).check();
  await form(page).getByLabel("Button label").fill("Book a visit");
  await form(page).getByLabel("Button link").fill("/contact");
  await form(page).getByRole("radio", { name: /^Columns/ }).check();
  await form(page).getByLabel(/^Copyright line/).fill("Since 1998");
  await form(page).getByRole("radio", { name: "Wide" }).check();
  await expect(form(page).getByTestId("appearance-unsaved")).toHaveText("Unsaved changes");

  // The preview shows them; visitors do not yet.
  await expect.poll(() => rootStyle(preview(page)), { timeout: 15_000 }).toContain("--forge-color-primary:#be123c");
  await expect(preview(page).locator("header.studio-header")).toHaveAttribute("data-variant", "centered");
  await expect(preview(page).getByRole("link", { name: "Book a visit" })).toHaveAttribute("href", `/s/${address}/contact`);
  await expect(preview(page).locator("footer.studio-footer")).toHaveAttribute("data-variant", "columns");
  await expect(preview(page).locator("footer")).toContainText("Since 1998");
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/s/${address}`);
  expect(await rootStyle(visitor)).toContain("--forge-color-primary:#1d4ed8");
  await expect(visitor.locator("header.studio-header")).toHaveAttribute("data-variant", "classic");

  // Saved: the server says so, then the live site shows it.
  await form(page).getByRole("button", { name: "Save appearance" }).click();
  await expect(notice(page)).toHaveText("Appearance saved. The site shows it now.");
  await expect(form(page).getByTestId("appearance-unsaved")).toHaveCount(0);
  await visitor.reload();
  expect(await rootStyle(visitor)).toContain("--forge-color-primary:#be123c");
  expect(await rootStyle(visitor)).toContain("--forge-content-width:72rem");
  await expect(visitor.locator("header.studio-header")).toHaveAttribute("data-variant", "centered");
  await expect(visitor.getByRole("link", { name: "Book a visit" })).toBeVisible();
  await expect(visitor.locator("footer.studio-footer")).toHaveAttribute("data-variant", "columns");
  await expect(visitor.locator("footer")).toContainText("Since 1998");
  await visitor.context().close();

  // What was saved is what the page shows when opened again; a change can be discarded.
  await page.reload();
  await expect(page.locator("#color-primary")).toHaveValue("#be123c");
  await expect(form(page).getByRole("radio", { name: /^Centred/ })).toBeChecked();
  await form(page).getByRole("radio", { name: "Compact" }).check();
  await expect(form(page).getByTestId("appearance-unsaved")).toBeVisible();
  await form(page).getByRole("button", { name: "Discard changes" }).click();
  await expect(form(page).getByRole("radio", { name: "Normal" }).last()).toBeChecked();
  await expect(form(page).getByTestId("appearance-unsaved")).toHaveCount(0);
});

test("a value that is not one is shown as such and cannot be saved; the editor fits a phone and works from the keyboard; an Editor may not open it", async ({ page }) => {
  const { base, org, member } = await withLiveSite(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/appearance`);
  await expect(form(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  await page.locator("#color-accent").fill("teal");
  await expect(form(page).getByText("Use a colour like #1d4ed8.")).toBeVisible();
  await expect(form(page).getByRole("button", { name: "Save appearance" })).toBeDisabled();
  await expect(page.getByTestId("appearance-preview").getByRole("status")).toHaveText("Fix the highlighted settings to update the preview.");

  // The keyboard: a valid colour typed, a radio chosen with the arrows, saved with Enter.
  await page.locator("#color-accent").fill("#0f766e");
  await form(page).getByRole("radio", { name: "Normal" }).first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(form(page).getByRole("radio", { name: "Wide" })).toBeChecked();
  await page.locator("#color-accent").press("Enter");
  await expect(notice(page)).toHaveText("Appearance saved. The site shows it now.");

  await addMember(org.id, member.email, "editor");
  await page.goto(`${base}/appearance`);
  await expect(page.getByText(/A site’s appearance is for Owners and Admins/)).toBeVisible();
  await expect(form(page)).toHaveCount(0);
});
