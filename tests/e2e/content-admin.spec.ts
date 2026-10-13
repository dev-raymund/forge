import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { draftOf, homePageOf, removeHomePage, seedEntry, seedPublishedEntry, seedTerm } from "./helpers/content";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf, type Role } from "./helpers/site-ui";
import { addMember, inTenant, seedUser } from "./helpers/sites";

/**
 * M5-7 end to end against the production build: the pages tree and the posts list, the new forms, the editor's
 * settings, who sees what (an Author: own posts, no pages), and a site without a Home page.
 */

const tail = () => randomBytes(3).toString("hex");
const editor = (page: Page) => page.getByTestId("editor");
const saved = (page: Page) => expect(page.getByTestId("autosave-status")).toHaveText(/^Saved at/, { timeout: 15_000 });
const nav = (page: Page) => page.getByRole("navigation", { name: /^Site:/ }).filter({ visible: true });
/** The new page or post form: the lists have a "Title" search of their own. */
const newForm = (page: Page, noun: "page" | "post") => page.getByRole("form", { name: `New ${noun}` });
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A member with a site the Owner made through the form (so it has its Home page); then given `role`. */
async function withSite(page: Page, role: Role = "owner") {
  const org = await seedOrganization("content");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `content-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  if (role !== "owner") await addMember(org.id, member.email, role);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  return { ...member, org, site: site!, base, home: (await homePageOf(org.id, site!.id))! };
}
const entryRow = async (orgId: string, id: string) =>
  (await inTenant(orgId, (c) => c.query<{ path: string; parent_id: string | null; author_id: string | null; sort_order: number }>("select path, parent_id, author_id, sort_order from entries where id = $1", [id]))).rows[0]!;
const userIdOf = async (email: string) => (await inTenant(uuidv7(), (c) => c.query<{ id: string }>("select id from users where email = $1", [email]))).rows[0]!.id;

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("pages: from the nav to a new page under another with a template, into its editor; the tree nests it; reorder by menu and by dragging; move under another page", async ({ page }) => {
  const { org, site, base } = await withSite(page);
  await nav(page).getByRole("link", { name: "Pages" }).click();
  await expect(page).toHaveURL(`${base}/pages`);
  await expect(page.getByTestId("page-row")).toHaveCount(1);
  await expect(page.getByTestId("home-badge")).toBeVisible();

  // Two pages from the form; the second under the first, with a template.
  await page.getByRole("link", { name: "New page" }).click();
  await newForm(page, "page").getByLabel("Title").fill("About us");
  await expect(page.getByRole("checkbox", { name: /Make it the home page/ })).not.toBeChecked(); // the site has one
  await page.getByRole("button", { name: "Create page" }).click();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`${base}/pages/[0-9a-f-]{36}$`));
  const about = page.url().split("/").at(-1)!;
  await expect(page.getByTestId("entry-title")).toHaveValue("About us");
  await page.goto(`${base}/pages/new`);
  await newForm(page, "page").getByLabel("Title").fill("Our team");
  await newForm(page, "page").getByLabel("Under").selectOption({ label: "About us (/about-us)" });
  await newForm(page, "page").getByLabel("Template").selectOption("landing");
  await page.getByRole("button", { name: "Create page" }).click();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  const team = page.url().split("/").at(-1)!;
  expect(await entryRow(org.id, team)).toMatchObject({ path: "/about-us/our-team", parent_id: about });
  await expect(page.getByTestId("entry-settings").getByLabel("Template")).toHaveValue("landing");
  await expect(page.getByTestId("entry-parent")).toHaveText("About us");

  // The tree: Our team under About us. A third top-level page to reorder.
  await page.goto(`${base}/pages/new`);
  await newForm(page, "page").getByLabel("Title").fill("Contact");
  await page.getByRole("button", { name: "Create page" }).click();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.goto(`${base}/pages`);
  const rows = page.getByTestId("page-row");
  await expect(rows).toHaveCount(4);
  const topLevel = () => page.locator('[data-testid="pages"] > li').evaluateAll((items) => items.map((item) => item.getAttribute("data-page")));
  await expect.poll(topLevel).toEqual(["About us", "Contact", "Home"]);
  await expect(page.locator('[data-page="About us"] [data-page="Our team"]')).toHaveCount(1);

  // Menu: Contact up.
  await page.getByRole("button", { name: "Arrange Contact" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect(page.locator('[role="status"]').filter({ hasText: "Moved to position 1." })).toBeVisible();
  await expect.poll(topLevel).toEqual(["Contact", "About us", "Home"]);
  // Drag: Home above Contact.
  const home = page.locator('[data-page="Home"] > div').first();
  const contact = page.locator('[data-page="Contact"] > div').first();
  await home.dragTo(contact, { targetPosition: { x: 40, y: 4 } });
  await expect.poll(topLevel).toEqual(["Home", "Contact", "About us"]);

  // Move under…: Contact under About us; the preview says where it goes; the tree and the database follow.
  await page.getByRole("button", { name: "Arrange Contact" }).click();
  await page.getByRole("menuitem", { name: "Move under…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move Contact" });
  await dialog.getByLabel("Under").selectOption({ label: "About us (/about-us)" });
  await expect(dialog.getByTestId("move-preview")).toContainText("/about-us/contact");
  await dialog.getByRole("button", { name: "Move page" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-page="About us"] [data-page="Contact"]')).toHaveCount(1);
  const contactId = (await inTenant(org.id, (c) => c.query<{ id: string }>("select id from entries where site_id = $1 and title = 'Contact'", [site.id]))).rows[0]!.id;
  expect(await entryRow(org.id, contactId)).toMatchObject({ path: "/about-us/contact", parent_id: about });

  // A loop is refused in the dialog, and nothing moves: About us cannot go under its own child.
  await page.getByRole("button", { name: "Arrange About us" }).click();
  await page.getByRole("menuitem", { name: "Move under…" }).click();
  const loop = page.getByRole("dialog", { name: "Move About us" });
  await expect(loop.getByLabel("Under").locator("option")).toHaveText(["The top level of the site", "Home (/)"]); // not itself, nor what is below it
  await loop.getByRole("button", { name: "Cancel" }).click();

  // Search and status filter: a flat list of what matches.
  await page.getByRole("form", { name: "Filter pages" }).getByLabel("Title").fill("team");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("/about-us/our-team");
  await page.goto(`${base}/pages?status=published`);
  await expect(page.getByTestId("no-pages")).toHaveText("No pages match these filters.");
});

test("posts: new post into its editor; slug, excerpt and a category saved with the draft; the list filters, searches, sorts and pages", async ({ page }) => {
  const { org, site, base, email } = await withSite(page);
  const bread = await seedTerm(org.id, site.id, "category", "bread", "Bread");
  await seedTerm(org.id, site.id, "tag", "rye", "Rye");
  await nav(page).getByRole("link", { name: "Posts" }).click();
  await expect(page.getByTestId("no-posts")).toContainText("This site has no posts yet.");
  await page.getByRole("link", { name: "Write the first one" }).click();
  await newForm(page, "post").getByLabel("Title").fill("Rye season");
  await expect(newForm(page, "post").getByLabel("Author")).toHaveValue(await userIdOf(email)); // an Owner may credit others: the select is there, set to them
  await page.getByRole("button", { name: "Create post" }).click();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  const id = page.url().split("/").at(-1)!;

  const settings = page.getByTestId("entry-settings");
  await expect(settings.getByTestId("entry-path")).toContainText("/blog/rye-season");
  await settings.getByLabel("Slug").fill("Rye Season!");
  await expect(settings.getByRole("alert")).toHaveText("Use lowercase letters, numbers and single hyphens, like about-us.");
  await settings.getByLabel("Slug").fill("rye-is-back");
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await expect(settings.getByTestId("entry-path")).toContainText("/blog/rye-is-back");
  await settings.getByLabel("Excerpt").fill("Dark and sour.");
  await settings.getByTestId("category-choices").getByLabel("Bread").check();
  await expect(settings.getByTestId("featured-image")).toContainText("once the media library is available");
  await editor(page).click();
  await page.keyboard.type("Rye is back.");
  await expect.poll(async () => (await draftOf(org.id, id)).slug, { timeout: 15_000 }).toBe("rye-is-back");
  await saved(page);
  const draft = (await inTenant(org.id, (c) => c.query<{ excerpt: string; term_ids: string[] }>("select excerpt, term_ids from entry_drafts where entry_id = $1", [id]))).rows[0]!;
  expect(draft).toEqual({ excerpt: "Dark and sour.", term_ids: [bread] });
  // Published: the address takes the new slug.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  expect((await entryRow(org.id, id)).path).toBe("/blog/rye-is-back");

  // More posts, behind the app's back: a draft by someone else, and 26 published to page through.
  const other = await seedUser("Petra Baker");
  await addMember(org.id, other.email, "author");
  await seedEntry(org.id, site.id, { id: uuidv7(), type: "post", title: "Petra's draft", slug: "petras-draft", path: "/blog/petras-draft", paragraphId: uuidv7() });
  await inTenant(org.id, (c) => c.query("update entries set author_id = $1 where title = $2 and site_id = $3", [other.id, "Petra's draft", site.id]));
  for (let i = 0; i < 26; i++) {
    await seedPublishedEntry(org.id, site.id, { id: uuidv7(), type: "post", title: `Old news ${i}`, slug: `old-news-${i}`, path: `/blog/old-news-${i}`, content: { v: 1, doc: { type: "doc", content: [] } } });
  }
  await page.goto(`${base}/posts`);
  const rows = page.getByTestId("post-row");
  await expect(rows).toHaveCount(25);
  await expect(page.getByRole("navigation", { name: "Pages of posts" })).toContainText("Page 1 of 2 · 28 posts");
  await page.getByRole("link", { name: "Next page" }).click();
  await expect(rows).toHaveCount(3);

  const filters = page.getByRole("form", { name: "Filter posts" });
  await page.goto(`${base}/posts`);
  await filters.getByLabel("Category").selectOption({ label: "Bread" });
  await filters.getByRole("button", { name: "Apply" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Rye season");
  await expect(rows.first()).toContainText("Bread");
  await page.goto(`${base}/posts`);
  await filters.getByLabel("Author").selectOption({ label: "Petra Baker" });
  await filters.getByLabel("Status").selectOption("draft");
  await filters.getByRole("button", { name: "Apply" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Petra's draft");
  await page.goto(`${base}/posts?q=old+news+1&sort=title`);
  await expect(rows.first()).toContainText("Old news 1");
  await expect(rows).toHaveCount(11); // 1, 10–19
});

test("the editor's settings: Set as home page (Owner), moving a page, changing a post's author", async ({ page }) => {
  const { org, site, base, home } = await withSite(page);
  const welcome = uuidv7();
  await seedEntry(org.id, site.id, { id: welcome, type: "page", title: "Welcome", slug: "welcome", path: "/welcome", paragraphId: uuidv7() });
  await page.goto(`${base}/pages/${welcome}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Set as home page" }).click();
  const confirm = page.getByRole("dialog", { name: "Make Welcome the home page?" });
  await confirm.getByRole("button", { name: "Set as home page" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText("This page is now the home page.")).toBeVisible();
  await expect(page.getByTestId("home-address")).toBeVisible();
  await expect(page.getByRole("button", { name: "Set as home page" })).toHaveCount(0);
  expect((await entryRow(org.id, welcome)).path).toBe("/");
  expect((await entryRow(org.id, home)).path).toBe("/home");

  // The old Home, moved under Welcome from its own editor's settings.
  await page.goto(`${base}/pages/${home}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("entry-settings").getByRole("button", { name: "Move…" }).click();
  const move = page.getByRole("dialog", { name: "Move Home" });
  await move.getByLabel("Under").selectOption({ label: "Welcome (/)" });
  await move.getByRole("button", { name: "Move page" }).click();
  await expect(page.getByTestId("entry-parent")).toHaveText("Welcome");
  expect(await entryRow(org.id, home)).toMatchObject({ parent_id: welcome, path: "/home" }); // under the Home page: still the top level

  // A post credited to another member.
  const petra = await seedUser("Petra Baker");
  await addMember(org.id, petra.email, "author");
  const story = uuidv7();
  await seedEntry(org.id, site.id, { id: story, type: "post", title: "Story", slug: "story", path: "/blog/story", paragraphId: uuidv7() });
  await page.goto(`${base}/posts/${story}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  const settings = page.getByTestId("entry-settings");
  await settings.getByLabel("Author").selectOption({ label: "Petra Baker" });
  await settings.getByRole("button", { name: "Change author" }).click();
  await expect(page.getByText("Author changed.")).toBeVisible();
  expect((await entryRow(org.id, story)).author_id).toBe(petra.id);
});

test("an Author: no Pages, only their own posts; another's post and any page are not found; a post of their own is written and published", async ({ page }) => {
  const { org, site, base, home } = await withSite(page, "author");
  const theirs = uuidv7();
  await seedEntry(org.id, site.id, { id: theirs, type: "post", title: "Someone else's", slug: "someone-elses", path: "/blog/someone-elses", paragraphId: uuidv7() });
  await page.goto(base);
  await expect(nav(page).getByRole("link")).toHaveText(["Overview", "Posts"]);
  await expect(page.getByTestId("home-page-link")).toHaveCount(0);
  await page.goto(`${base}/pages`);
  await expect(page.getByTestId("no-access")).toBeVisible();
  await page.goto(`${base}/pages/new`);
  await expect(page.getByTestId("no-access")).toBeVisible();
  for (const url of [`${base}/posts/${theirs}`, `${base}/pages/${home}`]) {
    await page.goto(url);
    await expect(page.getByTestId("not-found").filter({ visible: true }), url).toBeVisible();
  }

  await page.goto(`${base}/posts`);
  await expect(page.getByTestId("no-posts")).toContainText("You have not written a post on this site yet.");
  await expect(page.getByRole("form", { name: "Filter posts" }).getByLabel("Author")).toHaveCount(0);
  await page.getByRole("link", { name: "New post" }).click();
  await expect(newForm(page, "post")).toBeVisible();
  await expect(newForm(page, "post").getByLabel("Author")).toHaveCount(0); // only the "any" edit right credits others
  await newForm(page, "post").getByLabel("Title").fill("My first post");
  await page.getByRole("button", { name: "Create post" }).click();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("entry-author")).toContainText("Ada E2E");
  await page.goto(`${base}/posts`);
  await expect(page.getByTestId("post-row")).toHaveCount(1);
  await expect(page.getByTestId("post-row")).toContainText("My first post");
  // Asking the URL for someone else's posts changes nothing.
  const ownerId = (await inTenant(org.id, (c) => c.query<{ id: string }>("select author_id as id from entries where id = $1", [theirs]))).rows[0]!.id;
  await page.goto(`${base}/posts?author=${ownerId ?? uuidv7()}`);
  await expect(page.getByTestId("post-row")).toHaveCount(1);
});

test("a site without a Home page: the overview and the pages say so; the Owner creates one from there; a phone fits the screens", async ({ page }) => {
  const { org, site, base } = await withSite(page);
  await removeHomePage(org.id, site.id);
  await page.goto(base);
  await expect(page.getByTestId("home-page-missing").filter({ visible: true })).toHaveText("This site has no home page yet.");
  await page.getByTestId("create-home-page").filter({ visible: true }).click();
  await expect(page).toHaveURL(`${base}/pages/new?home=1`);
  await expect(page.getByRole("checkbox", { name: /Make it the home page/ })).toBeChecked();
  await page.setViewportSize({ width: 360, height: 740 });
  expect(await sideways(page)).toBe(0);
  await newForm(page, "page").getByLabel("Title").fill("Welcome home");
  await page.getByRole("button", { name: "Create page" }).click();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  expect(await sideways(page)).toBe(0);
  await expect(page.getByTestId("home-address")).toBeVisible();
  const id = page.url().split("/").at(-1)!;
  expect((await entryRow(org.id, id)).path).toBe("/");
  expect(await homePageOf(org.id, site.id)).toBe(id);

  await page.goto(`${base}/pages`);
  await expect(page.getByTestId("no-home-page")).toHaveCount(0);
  await expect(page.locator('[data-page="Welcome home"]').getByTestId("home-badge")).toBeVisible();
  expect(await sideways(page)).toBe(0);
  await page.goto(`${base}/posts`);
  expect(await sideways(page)).toBe(0);
});
