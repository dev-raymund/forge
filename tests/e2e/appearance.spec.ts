import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { asUniqueVisitor } from "./helpers/auth";
import { auditOf, seedOrganization, sitesIn, themeOf } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, seedUser } from "./helpers/sites";

/**
 * M4-4 end to end against the production build: choosing a site's theme on
 * `/{org}/sites/{site}/appearance`, who may, a phone; and every template of
 * both themes in the development gallery (`/dev/themes/{theme}/{template}`),
 * which draws them through the same contract the site renderer will use.
 */

const tail = () => randomBytes(3).toString("hex");
const shown = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });
const siteNav = (page: Page, name: string) => page.getByRole("navigation", { name: `Site: ${name}` });
const picker = (page: Page) => page.getByRole("form", { name: "Theme" });
const option = (page: Page, key: string) => picker(page).locator(`[data-testid="theme-option"][data-theme-key="${key}"]`);
const formStatus = (page: Page) => page.locator('[data-form-alert][role="status"]').filter({ visible: true });
const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A member with a new site, made through the form. */
async function withSite(page: Page, name = "Theme Test") {
  const member = await memberOf(page);
  const address = `theme-${tail()}`;
  await page.goto(`/${member.org.slug}/sites/new`);
  await createSite(page, { name, address });
  await expectSiteCreated(page, member.org.slug, address);
  await expect(shown(page, "site-name")).toHaveText(name);
  const [site] = await sitesIn(member.org.id);
  return { ...member, address, siteId: site!.id };
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("an Owner switches the site to Journal: saved, shown as current, and still so after a reload", async ({ page, baseURL }) => {
  const { org, address, siteId } = await withSite(page);

  await siteNav(page, "Theme Test").getByRole("link", { name: "Appearance" }).click();
  await expect(page).toHaveURL(`${baseURL}/${org.slug}/sites/${address}/appearance`);
  await expect(page.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible();

  // Studio, the default, is the current theme and the one selected.
  await expect(option(page, "studio").getByTestId("current-theme")).toHaveText("Current theme");
  await expect(option(page, "journal").getByTestId("current-theme")).toHaveCount(0);
  await expect(picker(page).getByRole("radio", { name: /Studio/ })).toBeChecked();
  await expect(picker(page).getByRole("radio", { name: /Journal/ })).not.toBeChecked();
  await expect(option(page, "journal")).toContainText("Warm and editorial");

  await option(page, "journal").click();
  await expect(picker(page).getByRole("radio", { name: /Journal/ })).toBeChecked();
  await picker(page).getByRole("button", { name: "Use this theme" }).click();
  await expect(formStatus(page)).toHaveText("The site now uses Journal.");
  await expect(option(page, "journal").getByTestId("current-theme")).toBeVisible();
  await expect(option(page, "studio").getByTestId("current-theme")).toHaveCount(0);
  expect(await themeOf(org.id, siteId)).toBe("journal");
  expect((await auditOf(org.id)).at(-1)).toMatchObject({ action: "site.theme_changed", metadata: { name: "Theme Test", previousTheme: "studio", newTheme: "journal" } });

  await page.reload();
  await expect(option(page, "journal").getByTestId("current-theme")).toBeVisible();
  await expect(picker(page).getByRole("radio", { name: /Journal/ })).toBeChecked();

  // The site's own page says so too.
  await siteNav(page, "Theme Test").getByRole("link", { name: "Overview" }).click();
  await expect(shown(page, "site-theme")).toHaveText("Journal");

  // With the keyboard: arrows move between the themes, the button saves.
  await page.goto(`/${org.slug}/sites/${address}/appearance`);
  const journal = picker(page).getByRole("radio", { name: /Journal/ });
  await journal.focus();
  await page.keyboard.press("ArrowLeft");
  const studio = picker(page).getByRole("radio", { name: /Studio/ });
  await expect(studio).toBeChecked();
  await expect(studio).toBeFocused();
  await picker(page).getByRole("button", { name: "Use this theme" }).click();
  await expect(formStatus(page)).toHaveText("The site now uses Studio.");
  expect(await themeOf(org.id, siteId)).toBe("studio");
});

test("an Editor has no Appearance link, and the page says it is not theirs; the theme is unchanged", async ({ page, baseURL }) => {
  const org = await seedOrganization("looks");
  const owner = await seedUser();
  await addMember(org.id, owner.email, "owner");
  await memberOf(page, "admin", org);
  const address = `editor-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Editors Look", address });
  await expectSiteCreated(page, org.slug, address);
  await expect(shown(page, "site-name")).toHaveText("Editors Look");
  const [site] = await sitesIn(org.id);

  const context = await page.context().browser()!.newContext();
  const editor = await context.newPage();
  await asUniqueVisitor(editor);
  await memberOf(editor, "editor", org);
  await editor.goto(`/${org.slug}/sites/${address}`);
  await expect(siteNav(editor, "Editors Look").getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(siteNav(editor, "Editors Look").getByRole("link", { name: "Appearance" })).toHaveCount(0);
  await editor.goto(`/${org.slug}/sites/${address}/appearance`);
  await expect(editor).toHaveURL(`${baseURL}/${org.slug}/sites/${address}/appearance`);
  await expect(shown(editor, "no-access")).toContainText("A site’s appearance is for Owners and Admins");
  await expect(picker(editor)).toHaveCount(0);
  expect(await themeOf(org.id, site!.id)).toBe("studio");
  await context.close();
});

test("on a phone (360 px): the theme picker fits, and works", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const { org, address, siteId } = await withSite(page, "Small Screen");
  await page.goto(`/${org.slug}/sites/${address}/appearance`);
  await expect(picker(page)).toBeVisible();
  expect(await sidewaysScroll(page)).toBe(0);
  await option(page, "journal").click();
  await picker(page).getByRole("button", { name: "Use this theme" }).click();
  await expect(formStatus(page)).toHaveText("The site now uses Journal.");
  expect(await sidewaysScroll(page)).toBe(0);
  expect(await themeOf(org.id, siteId)).toBe("journal");
});

test.describe("the theme gallery (development only)", () => {
  for (const theme of ["studio", "journal"]) {
    for (const template of ["page", "coming-soon", "not-found"]) {
      test(`${theme} / ${template}: drawn by the theme, accessible landmarks, the site's words as text, and it fits a phone`, async ({ page }) => {
        const response = (await page.goto(`/dev/themes/${theme}/${template}`))!;
        expect(response.status()).toBe(200);
        await expect(page.locator(`[data-forge-theme][data-theme="${theme}"]`)).toHaveCount(1);
        await expect(page.getByRole("banner")).toHaveCount(1);
        await expect(page.getByRole("main")).toHaveCount(1);
        await expect(page.getByRole("contentinfo")).toHaveCount(1);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
        // The made-up site's name and tagline carry markup: it is text, and nothing ran.
        await expect(page.getByText("Harbor & Pine <Studio>").first()).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
        // The settings arrive as CSS variables on the theme's root, and only the site's two fonts are in use.
        const primary = await page.locator("[data-forge-theme]").evaluate((element) => getComputedStyle(element).getPropertyValue("--forge-color-primary").trim());
        expect(primary).toBe(theme === "studio" ? "#1d4ed8" : "#9a3412");
        // The first Tab reaches the skip link, which leads to the content.
        await page.keyboard.press("Tab");
        await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
        await page.setViewportSize({ width: 360, height: 740 });
        expect(await sidewaysScroll(page)).toBe(0);
      });
    }
  }
});
