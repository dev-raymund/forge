import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { axeViolations } from "./helpers/axe";
import { seedPublishedEntry, seedSiteSettings, seedTerm } from "./helpers/content";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, seedSite, seedUser, type SeededSite } from "./helpers/sites";

/**
 * M8-2 end to end against the production build: Journal's own blog on a live site (the index with its lead and its
 * pages, a post, a category's and a tag's archive and their later pages, after navigating and after a reload), only
 * what is published and the site's own, no axe violation, at a phone's, a tablet's and a desk's width; other valid
 * branding (a dark palette, other fonts and layout) still readable, and one site's never another's; and the kit-level
 * settings, saved in the appearance editor, kept across Studio → Journal → Studio.
 */

test.describe.configure({ timeout: 120_000 });

const tail = () => randomBytes(3).toString("hex");
const id = () => uuidv7();
const p = (text: string) => ({ type: "paragraph", attrs: { id: id() }, content: [{ type: "text", text }] });
const doc = (...content: unknown[]) => ({ v: 1, doc: { type: "doc", content } });
const url = (site: SeededSite, path = "") => `/s/${site.address}${path}`;
const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const rootStyle = (page: Page) => page.locator("[data-forge-theme]").getAttribute("style");

/** A live Journal site: four posts (two a page; three in a category, one tagged), a draft, and another site's post. */
async function seedJournal() {
  const site = await seedSite("journal", "Notes from the oven", { status: "live", theme: "journal" });
  const other = await seedSite("other", "Someone else", { status: "live", theme: "journal" });
  await seedSiteSettings(site.orgId, site.siteId, { reading: { blogPath: "notes", postsPerPage: 2 } });
  const bread = await seedTerm(site.orgId, site.siteId, "category", "bread", "Bread", "Loaves of every kind");
  const rye = await seedTerm(site.orgId, site.siteId, "tag", "rye", "Rye");
  const day = (n: number) => new Date(Date.UTC(2026, 8, n, 9));
  await seedPublishedEntry(site.orgId, site.siteId, {
    id: id(), type: "post", title: "Rye season, and a title long enough to wrap across several lines on a phone: Roggenvollkornsauerteigbrotbackstube",
    slug: "rye-season", path: "/notes/rye-season", excerpt: "Dark and sour.", termIds: [bread, rye], publishedAt: day(20),
    content: doc(p("Rye is back."), p("Bake it slowly."), p("https://example.com/recipes/rye/a-very-long-address-with-no-spaces-at-all-to-break-a-line-on")),
  });
  await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "post", title: "Our new oven", slug: "new-oven", path: "/notes/new-oven", excerpt: "", termIds: [], publishedAt: day(10), content: doc(p("It is big.")) });
  await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "post", title: "Seeded rye", slug: "seeded-rye", path: "/notes/seeded-rye", excerpt: "With caraway.", termIds: [bread], publishedAt: day(5), content: doc(p("Caraway.")) });
  await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "post", title: "Opening day", slug: "opening-day", path: "/notes/opening-day", excerpt: "We opened.", termIds: [bread], publishedAt: day(1), content: doc(p("Come in.")) });
  await seedPublishedEntry(site.orgId, site.siteId, { id: id(), type: "post", title: "Unfinished", slug: "unfinished", path: "/notes/unfinished", content: doc(p("Draft")), draftOnly: true });
  await seedPublishedEntry(other.orgId, other.siteId, { id: id(), type: "post", title: "Their post", slug: "their-post", path: "/blog/their-post", publishedAt: day(25), content: doc(p("Not yours")) });
  return site;
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("Journal's blog: the index (a lead, two pages), a post, a category (two pages) and a tag archive; after a reload too; only this site's published posts; no axe violation; phone, tablet and desk", async ({ page }) => {
  const site = await seedJournal();
  const titles = () => page.locator(".journal-entry__title a");

  // The blog, newest first, the first one the lead, two a page.
  await page.goto(url(site, "/notes"));
  await expect(page.locator("[data-forge-theme]")).toHaveAttribute("data-theme", "journal");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blog");
  await expect(titles()).toHaveText([/^Rye season/, "Our new oven"]);
  await expect(page.locator(".journal-entry--lead")).toHaveCount(1);
  await expect(page.locator(".journal-entry--lead .journal-entry__excerpt")).toHaveText("Dark and sour.");
  await expect(page.locator(".journal-entry").nth(1).locator(".journal-entry__excerpt")).toHaveCount(0); // no excerpt, no empty paragraph
  await expect(page.locator(".journal-archive__where")).toHaveText("Page 1 of 2");
  expect(await axeViolations(page)).toEqual([]);
  const pages = page.getByRole("navigation", { name: "Pages of posts" });
  await pages.getByRole("link", { name: /Older posts/ }).click();
  await expect(page).toHaveURL(new RegExp(`${url(site, "/notes/page/2")}$`));
  await expect(titles()).toHaveText(["Seeded rye", "Opening day"]);
  await expect(page.locator(".journal-entry--lead")).toHaveCount(0);
  await expect(page.locator(".journal-archive__where")).toHaveText("Page 2 of 2");
  expect(await axeViolations(page)).toEqual([]);
  await page.reload();
  await expect(titles()).toHaveText(["Seeded rye", "Opening day"]);
  // Never listed: the draft, and the other site's post.
  for (const path of ["/notes", "/notes/page/2"]) {
    await page.goto(url(site, path));
    await expect(page.getByRole("main")).not.toContainText("Unfinished");
    await expect(page.getByRole("main")).not.toContainText("Their post");
  }

  // A post: its category as the kicker, the date, what it is filed under, the way back.
  await page.goto(url(site, "/notes/rye-season"));
  await expect(page.locator(".journal-post")).toHaveCount(1);
  await expect(page.locator(".journal-kicker").getByRole("link", { name: "Bread" })).toHaveAttribute("href", url(site, "/notes/category/bread"));
  await expect(page.locator(".journal-post__date time")).toHaveAttribute("datetime", "2026-09-20T09:00:00.000Z");
  await expect(page.getByRole("list", { name: "Tagged" }).getByRole("link", { name: "Rye" })).toHaveAttribute("href", url(site, "/notes/tag/rye"));
  await expect(page.getByRole("link", { name: "All posts" })).toHaveAttribute("href", url(site, "/notes"));
  await expect(page.getByRole("main")).toContainText("Bake it slowly.");
  expect(await axeViolations(page)).toEqual([]);
  // A post with no excerpt, terms or image: nothing empty is drawn.
  await page.goto(url(site, "/notes/new-oven"));
  await expect(page.locator(".journal-terms, .journal-post__image, .forge-featured-image")).toHaveCount(0);
  await expect(page.locator(".journal-kicker")).toHaveText("Blog");

  // The archives say what they are, with only their posts.
  await page.goto(url(site, "/notes/category/bread"));
  await expect(page.locator(".journal-kicker")).toHaveText("Blog · Category");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bread");
  await expect(page.locator(".journal-archive__description")).toHaveText("Loaves of every kind");
  await expect(titles()).toHaveText([/^Rye season/, "Seeded rye"]);
  await expect(page.locator(".journal-archive__where")).toHaveText("Page 1 of 2");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("navigation", { name: "Pages of posts" }).getByRole("link", { name: /Older posts/ }).click();
  await expect(page).toHaveURL(new RegExp(`${url(site, "/notes/category/bread/page/2")}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bread");
  await expect(titles()).toHaveText(["Opening day"]);
  expect(await axeViolations(page)).toEqual([]);
  await page.reload();
  await expect(titles()).toHaveText(["Opening day"]);
  await page.goto(url(site, "/notes/tag/rye"));
  await expect(page.locator(".journal-kicker")).toHaveText("Blog · Tag");
  await expect(titles()).toHaveText([/^Rye season/]);
  expect(await axeViolations(page)).toEqual([]);
  // An unknown term and a page past the end are not found, in Journal's words.
  for (const path of ["/notes/tag/nothing", "/notes/page/3", "/notes/category/bread/page/3"]) {
    expect((await page.goto(url(site, path)))!.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  }

  // Every width: nothing scrolls sideways, the long title, its unbroken word and the long address included.
  for (const [width, height] of [[360, 740], [768, 1024], [1280, 900]] as const) {
    await page.setViewportSize({ width, height });
    for (const path of ["/notes", "/notes/page/2", "/notes/rye-season", "/notes/category/bread"]) {
      await page.goto(url(site, path));
      expect(await sidewaysScroll(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
  // At a desk's width the way back lines up with the text (a `ch` measure taken at the link's smaller size once moved it right).
  await page.goto(url(site, "/notes/rye-season"));
  const left = async (selector: string) => (await page.locator(selector).boundingBox())!.x;
  expect(Math.abs((await left(".journal-post__back a")) - (await left(".journal-post__body")))).toBeLessThan(1);
  expect(Math.abs((await left(".journal-terms")) - (await left(".journal-post__body")))).toBeLessThan(1);
});

test("other valid branding (a dark palette, sans-serif fonts, wide, compact, square) stays readable: no axe violation at a phone's and a desk's width; another Journal site keeps its own", async ({ page }) => {
  const dusk = {
    tokens: { colors: { primary: "#fdba74", accent: "#5eead4", background: "#1c1917", text: "#f5f5f4" }, fonts: { heading: "inter", body: "dm-sans" } },
    layout: { width: "wide", radius: "none", density: "compact" },
  };
  const site = await seedSite("dusk", "After hours", { status: "live", theme: "journal", themeSettings: dusk });
  const plain = await seedSite("plain", "Defaults", { status: "live", theme: "journal" });
  const bread = await seedTerm(site.orgId, site.siteId, "category", "bread", "Bread", "Loaves");
  const tag = await seedTerm(site.orgId, site.siteId, "tag", "night", "Night");
  await seedPublishedEntry(site.orgId, site.siteId, {
    id: id(), type: "post", title: "Night loaves", slug: "night-loaves", path: "/blog/night-loaves", excerpt: "Baked after dark.", termIds: [bread, tag],
    publishedAt: new Date(Date.UTC(2026, 8, 2, 9)), content: doc(p("Slow and dark.")),
  });

  for (const [width, height] of [[360, 740], [1280, 900]] as const) {
    await page.setViewportSize({ width, height });
    for (const path of ["/blog", "/blog/night-loaves", "/blog/category/bread"]) {
      await page.goto(url(site, path));
      expect(await axeViolations(page), `${path} at ${width}px`).toEqual([]);
      expect(await sidewaysScroll(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
  const style = await rootStyle(page);
  for (const variable of ["--forge-color-background:#1c1917", "--forge-color-text:#f5f5f4", "--forge-color-primary:#fdba74", "--forge-content-width:72rem", "--forge-radius:0"]) {
    expect(style, variable).toContain(variable);
  }

  // The other Journal site: its own (default) look, and its empty blog says so.
  await page.goto(url(plain, "/blog"));
  const plainStyle = await rootStyle(page);
  expect(plainStyle).toContain("--forge-color-background:#fffdf8");
  for (const variable of ["--forge-color-background:#1c1917", "--forge-color-primary:#fdba74", "--forge-content-width:72rem"]) expect(plainStyle, variable).not.toContain(variable);
  await expect(page.locator(".journal-empty")).toHaveText("Nothing has been published here yet.");
  expect(await axeViolations(page)).toEqual([]);
});

test("the kit-level settings, saved in the appearance editor, are Journal's too, and switching Studio → Journal → Studio keeps them", async ({ page, browser }) => {
  const org = await seedOrganization("journal");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `journal-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  await page.goto(base);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Live", { timeout: 15_000 });

  // In Studio: a colour, a width, corners, and Studio's minimal header and columns footer.
  await page.goto(`${base}/appearance`);
  const form = page.getByTestId("appearance-form");
  await page.locator("#color-primary").fill("#be123c");
  await form.getByRole("radio", { name: /^Minimal/ }).check();
  await form.getByRole("radio", { name: /^Columns/ }).check();
  await form.getByRole("radio", { name: "Wide" }).check();
  await form.getByLabel("Corners").selectOption({ label: "Large" });
  await form.getByRole("button", { name: "Save appearance" }).click();
  await expect(form.locator("[data-form-alert]")).toHaveText("Appearance saved. The site shows it now.");

  // Journal: the same colour, width and corners; its own masthead and footer (it draws one of each).
  const choose = async (theme: "Journal" | "Studio") => {
    await page.goto(`${base}/appearance`);
    await page.getByRole("form", { name: "Theme" }).locator(`[data-theme-key="${theme.toLowerCase()}"]`).click();
    await page.getByRole("form", { name: "Theme" }).getByRole("button", { name: "Use this theme" }).click();
    await expect(page.getByRole("heading", { name: `Customise ${theme}` })).toBeVisible({ timeout: 15_000 });
  };
  await choose("Journal");
  await expect(page.locator("#color-primary")).toHaveValue("#be123c");
  await expect(page.getByTestId("appearance-form").getByRole("radio", { name: "Wide" })).toBeChecked();
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/s/${address}`);
  await expect(visitor.locator("[data-forge-theme]")).toHaveAttribute("data-theme", "journal");
  for (const variable of ["--forge-color-primary:#be123c", "--forge-content-width:72rem", "--forge-radius:1rem"]) expect(await rootStyle(visitor), variable).toContain(variable);
  await expect(visitor.locator("header.journal-header")).toHaveCount(1);
  await expect(visitor.locator("footer.journal-footer")).toHaveCount(1);
  expect(await axeViolations(visitor)).toEqual([]);

  // Back to Studio: everything as it was, its header and footer variants included.
  await choose("Studio");
  await expect(page.getByTestId("appearance-form").getByRole("radio", { name: /^Minimal/ })).toBeChecked();
  await visitor.reload();
  await expect(visitor.locator("[data-forge-theme]")).toHaveAttribute("data-theme", "studio");
  expect(await rootStyle(visitor)).toContain("--forge-color-primary:#be123c");
  await expect(visitor.locator("header.studio-header")).toHaveAttribute("data-variant", "minimal");
  await expect(visitor.locator("footer.studio-footer")).toHaveAttribute("data-variant", "columns");
  await visitor.context().close();
});
