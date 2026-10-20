import { randomBytes } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { axeViolations } from "./helpers/axe";
import { seedPublishedEntry, seedTerm } from "./helpers/content";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, inTenant, seedSite, seedUser } from "./helpers/sites";

/**
 * M8-3 end to end against the production build: a site's header and footer menus built on `/…/menus` (search, a
 * category, the blog, an address; nested by keyboard and by dragging; a label of its own; a new tab) and drawn by the
 * live site at once; a linked page unpublished and put in the trash leaves the site's menu at once and is flagged in
 * the editor, and comes back when published again; both themes and every header and footer variant drawing two levels
 * at a phone's and a desk's width, by keyboard, with no axe violation; and who may.
 */

test.describe.configure({ timeout: 120_000 });

const tail = () => randomBytes(3).toString("hex");
const id = () => uuidv7();
const doc = (text: string) => ({ v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: id() }, content: [{ type: "text", text }] }] } });
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const source = (form: Locator, word: string) => form.getByRole("radiogroup", { name: "What to link to" }).getByText(word, { exact: true }).click();
async function addEntry(form: Locator, query: string, title: string) {
  await source(form, "Page or post");
  await form.getByLabel("Search pages and posts").fill(query);
  await form.getByRole("button", { name: `Add ${title}` }).click();
}
/** The editor's rows, as they are nested: `["A", "  B"]`. */
const rowsOf = (form: Locator) =>
  form.getByTestId("menu-item").evaluateAll((rows) => rows.map((row) => `${row.getAttribute("data-depth") === "1" ? "  " : ""}${row.getAttribute("data-label")}`));
/** A visitor's view of a navigation: its links, the ones under a link indented. */
const linksOf = (nav: Locator) =>
  nav.locator("a").evaluateAll((links) => links.map((a) => `${a.closest(".forge-nav__sub") ? "  " : ""}${a.firstChild?.textContent} ${a.getAttribute("href")}${a.getAttribute("target") ? " (new tab)" : ""}`));

/** A member with a live site made through the form (Studio). */
async function withLiveSite(page: Page) {
  const org = await seedOrganization("menus");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `menus-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  await page.goto(base);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Live", { timeout: 15_000 });
  return { org, site: site!, base, address };
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("menus built in the admin (search, a category, the blog, an address; nested by keyboard and by dragging; own labels; a new tab) are on the live site at once", async ({ page, browser }) => {
  const { org, site, base, address } = await withLiveSite(page);
  await seedPublishedEntry(org.id, site.id, { id: id(), type: "page", title: "About", slug: "about", path: "/about", content: doc("About us.") });
  await seedPublishedEntry(org.id, site.id, { id: id(), type: "page", title: "Team", slug: "team", path: "/team", content: doc("Our team.") });
  await seedTerm(org.id, site.id, "category", "bread", "Bread");

  // From the site's links, and from the overview's checklist.
  await page.goto(base);
  await expect(page.getByRole("link", { name: "Set up your menu" })).toHaveAttribute("href", `${base}/menus`);
  await page.getByRole("navigation", { name: /^Site:/ }).getByRole("link", { name: "Menus" }).click();
  await expect(page.getByRole("heading", { name: "Menus", level: 1 })).toBeVisible();
  const header = page.getByTestId("menu-header");
  const footer = page.getByTestId("menu-footer");
  await expect(header.getByTestId("menu-empty")).toBeVisible();

  await addEntry(header, "About", "About");
  await addEntry(header, "Team", "Team");
  await source(header, "Blog");
  await header.getByRole("button", { name: "Add the blog" }).click();
  await source(header, "Category");
  await header.getByLabel("Choose a category").selectOption({ label: "Bread" });
  await header.getByRole("button", { name: "Add category" }).click();
  await source(header, "Address");
  await header.getByLabel("Link text").fill("Shop");
  await header.getByLabel("Link to", { exact: true }).fill("javascript:alert(1)");
  await header.getByRole("button", { name: "Add address" }).click();
  await expect(header.getByText("Use a path on the site, like /contact, or a full address starting with https://.")).toBeVisible();
  await header.getByLabel("Link to", { exact: true }).fill("https://shop.example.com");
  await header.getByRole("checkbox", { name: "Open in a new tab" }).check();
  await header.getByRole("button", { name: "Add address" }).click();
  expect(await rowsOf(header)).toEqual(["About", "Team", "Blog", "Bread", "Shop"]);

  // Nested from the keyboard: Team under About (its Arrange menu, opened and chosen with keys).
  await header.getByRole("button", { name: "Arrange Team" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Move under the link above" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Move under the link above" }).focus();
  await page.keyboard.press("Enter");
  // Nested by dragging: Bread dropped onto the middle of Blog.
  await header.locator('[data-label="Bread"] > div').first().dragTo(header.locator('[data-label="Blog"] > div').first(), { targetPosition: { x: 200, y: 26 } });
  expect(await rowsOf(header)).toEqual(["About", "  Team", "Blog", "  Bread", "Shop"]);
  // A label of its own.
  await header.getByRole("button", { name: "Edit Blog" }).click();
  await header.getByLabel(/^Label/).fill("Journal");
  await header.getByRole("button", { name: "Done Journal" }).click();
  await expect(header.getByTestId("menu-header-unsaved")).toHaveText("Unsaved changes");
  await header.getByRole("button", { name: "Save header menu" }).click();
  await expect(header.locator("[data-form-alert]")).toHaveText("Header menu saved. The site shows it now.");
  await expect(header.getByTestId("menu-header-unsaved")).toHaveCount(0);

  await addEntry(footer, "About", "About");
  await footer.getByRole("button", { name: "Edit About" }).click();
  await footer.getByLabel(/^Label/).fill("Our story");
  await footer.getByRole("button", { name: "Save footer menu" }).click();
  await expect(footer.locator("[data-form-alert]")).toHaveText("Footer menu saved. The site shows it now.");

  // Reopened: as saved.
  await page.reload();
  expect(await rowsOf(page.getByTestId("menu-header"))).toEqual(["About", "  Team", "Journal", "  Bread", "Shop"]);

  // The live site, on the very next request.
  const visitor = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await visitor.goto(`/s/${address}`);
  const main = visitor.getByRole("navigation", { name: "Main" });
  expect(await linksOf(main)).toEqual([
    `About /s/${address}/about`, `  Team /s/${address}/team`, `Journal /s/${address}/blog`, `  Bread /s/${address}/blog/category/bread`, "Shop https://shop.example.com (new tab)",
  ]);
  await expect(main.getByRole("link", { name: "Team" })).toBeHidden();
  await main.locator("summary").first().click();
  await expect(main.getByRole("link", { name: "Team" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Shop (opens in a new tab)" })).toHaveAttribute("rel", "noopener noreferrer");
  expect(await linksOf(visitor.getByRole("navigation", { name: "Footer" }))).toEqual([`Our story /s/${address}/about`]);
  expect(await axeViolations(visitor)).toEqual([]);
  expect(await sideways(visitor)).toBeLessThanOrEqual(0);
  // Its last link's panel opens towards the page.
  await main.locator("summary").nth(1).click();
  const panel = (await main.locator(".forge-nav__sub").nth(1).boundingBox())!;
  expect(panel.x + panel.width).toBeLessThanOrEqual(1280);
  expect(await sideways(visitor)).toBeLessThanOrEqual(0);
  await visitor.context().close();
});

test("a linked page unpublished and put in the trash leaves the live site's menu at once, is flagged in the editor, and comes back when published again", async ({ page, browser }) => {
  const { org, site, base, address } = await withLiveSite(page);
  const offers = id();
  await seedPublishedEntry(org.id, site.id, { id: offers, type: "page", title: "Offers", slug: "offers", path: "/offers", content: doc("This week's offers.") });
  await seedPublishedEntry(org.id, site.id, { id: id(), type: "page", title: "About", slug: "about", path: "/about", content: doc("About us.") });
  await page.goto(`${base}/menus`);
  const header = page.getByTestId("menu-header");
  await addEntry(header, "Offers", "Offers");
  await addEntry(header, "About", "About");
  await header.getByRole("button", { name: "Save header menu" }).click();
  await expect(header.locator("[data-form-alert]")).toHaveText("Header menu saved. The site shows it now.");

  const visitor = await (await browser.newContext()).newPage();
  const mainLinks = () => linksOf(visitor.getByRole("navigation", { name: "Main" }));
  await visitor.goto(`/s/${address}/about`);
  expect(await mainLinks()).toEqual([`Offers /s/${address}/offers`, `About /s/${address}/about`]);

  // Unpublished, then into the trash, from its editor.
  await page.goto(`${base}/pages/${offers}`);
  await page.getByRole("button", { name: "Unpublish" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Draft", { timeout: 15_000 });
  await visitor.reload();
  expect(await mainLinks()).toEqual([`About /s/${address}/about`]);
  await page.getByTestId("trash-section").getByRole("button", { name: "Move to trash…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to trash" }).click();
  await expect(page).toHaveURL(`${base}/pages?status=trash`);
  await visitor.reload();
  expect(await mainLinks()).toEqual([`About /s/${address}/about`]);
  expect(await visitor.content()).not.toContain("Offers");

  // The editor keeps the link, and says why the site leaves it out.
  await page.goto(`${base}/menus`);
  expect(await rowsOf(page.getByTestId("menu-header"))).toEqual(["Offers", "About"]);
  await expect(page.getByTestId("menu-header").getByTestId("menu-item-warning")).toHaveText("Not on the site: it is in the trash. Restore and publish it, or remove this link.");

  // Restored (a draft), then published: back in the menu, with no change to the menu.
  await page.goto(`${base}/pages?status=trash`);
  await page.getByTestId("trash-item").filter({ has: page.getByText("Offers", { exact: true }) }).getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("trash-item").filter({ has: page.getByText("Offers", { exact: true }) })).toHaveCount(0, { timeout: 15_000 });
  await visitor.reload();
  expect(await mainLinks()).toEqual([`About /s/${address}/about`]);
  await page.goto(`${base}/pages/${offers}`);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  await visitor.reload();
  expect(await mainLinks()).toEqual([`Offers /s/${address}/offers`, `About /s/${address}/about`]);
  await visitor.context().close();
});

/** Menus written as the editor saves them, before any public page of the site is read. */
async function seedMenus(orgId: string, siteId: string, header: unknown[], footer: unknown[]) {
  await inTenant(orgId, async (c) => {
    for (const [location, items] of [["header", header], ["footer", footer]] as const) {
      await c.query("insert into menus (id, organization_id, site_id, location, items) values ($1, $2, $3, $4, $5)", [id(), orgId, siteId, location, JSON.stringify(items)]);
    }
  });
}
const toUrl = (url: string, label: string, extra: Record<string, unknown> = {}) => ({ id: id(), kind: "url", url, label, newTab: false, ...extra });

test("both themes and every header and footer variant draw two levels: by keyboard, at a phone's and a desk's width, with no axe violation", async ({ page }) => {
  const variants = [
    { theme: "journal", header: "centered", footer: "simple" },
    { theme: "studio", header: "classic", footer: "simple" },
    { theme: "studio", header: "centered", footer: "columns" },
    { theme: "studio", header: "minimal", footer: "columns" },
  ];
  for (const { theme, header, footer } of variants) {
    const site = await seedSite(`nav-${theme}`, "Two levels", { status: "live", theme, themeSettings: { header: { variant: header, cta: { label: "Book", href: "/contact" } }, footer: { variant: footer } } });
    const services = toUrl("/services", "Services", { children: [toUrl("/services/interiors", "Interiors"), toUrl("/services/kitchens", "Small kitchens and pantries")] });
    const studio = toUrl("/about", "Studio", { children: [toUrl("/about/team", "Team"), toUrl("https://jobs.example.com", "Careers", { newTab: true })] });
    await seedMenus(site.orgId, site.siteId, [toUrl("/work", "Work"), services, toUrl("/journal", "Journal"), studio], [studio, toUrl("/privacy", "Privacy")]);
    const where = `${theme} ${header}/${footer}`;

    for (const [width, height] of [[360, 780], [1280, 900]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/s/${site.address}`);
      const main = page.getByRole("navigation", { name: "Main" });
      await expect(main.getByRole("link", { name: "Interiors" }), where).toBeHidden();
      // By keyboard: Tab from the link to its button, Enter opens it, Tab reaches the first link under it.
      await main.getByRole("link", { name: "Services" }).focus();
      await page.keyboard.press("Tab");
      await expect(main.locator("summary").first(), where).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(main.getByRole("link", { name: "Interiors" }), where).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(main.getByRole("link", { name: "Interiors" }), where).toBeFocused();
      // The last link's links open too; nothing goes past the page's edge.
      await main.locator("summary").nth(1).click();
      await expect(main.getByRole("link", { name: "Team" }), where).toBeVisible();
      for (const name of ["Small kitchens and pantries", "Careers (opens in a new tab)"]) {
        const box = (await main.getByRole("link", { name }).boundingBox())!;
        expect(box.x, `${where} ${name} at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${where} ${name} at ${width}px`).toBeLessThanOrEqual(width);
      }
      expect(await sideways(page), `${where} at ${width}px`).toBeLessThanOrEqual(0);
      expect(await axeViolations(page), `${where} at ${width}px`).toEqual([]);
      // The footer lists the links under a link, always shown.
      await expect(page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Team" }), where).toBeVisible();
    }
  }
});

test("Owners, Admins and Editors manage menus; Authors and Viewers have no link to them, and the page says so", async ({ page, browser }) => {
  const site = await seedSite("roles", "Who may", { status: "live" });
  const org = { id: site.orgId, slug: `org-${site.address}`, name: `Org ${site.address}` };
  const base = `/${org.slug}/sites/${site.address}`;

  const editor = await memberOf(page, "editor", org);
  await markEmailVerified(editor.email);
  await page.goto(base);
  await page.getByRole("navigation", { name: /^Site:/ }).getByRole("link", { name: "Menus" }).click();
  const header = page.getByTestId("menu-header");
  await source(header, "Blog");
  await header.getByRole("button", { name: "Add the blog" }).click();
  await header.getByRole("button", { name: "Save header menu" }).click();
  await expect(header.locator("[data-form-alert]")).toHaveText("Header menu saved. The site shows it now.");

  for (const role of ["author", "viewer"] as const) {
    const context = await browser.newContext();
    const other = await context.newPage();
    await asUniqueVisitor(other);
    await memberOf(other, role, org);
    await other.goto(base);
    await expect(other.getByRole("navigation", { name: /^Site:/ }), role).toBeVisible();
    await expect(other.getByRole("navigation", { name: /^Site:/ }).getByRole("link", { name: "Menus" }), role).toHaveCount(0);
    await other.goto(`${base}/menus`);
    await expect(other.getByText("A site’s menus are for Owners, Admins and Editors"), role).toBeVisible();
    await expect(other.getByTestId("menu-header"), role).toHaveCount(0);
    await context.close();
  }

  // A phone: the editor fits, and its links are arranged from the keyboard.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.reload();
  await expect(page.getByTestId("menu-header").getByTestId("menu-item")).toHaveCount(1);
  expect(await sideways(page)).toBeLessThanOrEqual(0);
});
