import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { seedEntry, seedPublishedEntry, seedTerm } from "./helpers/content";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf, type Role } from "./helpers/site-ui";
import { addMember, inTenant, seedUser } from "./helpers/sites";

/**
 * M5-8 end to end against the production build: the category and tag screens, a tag added while writing a post,
 * and the public archives following each change on the next request.
 */

const tail = () => randomBytes(3).toString("hex");
const editor = (page: Page) => page.getByTestId("editor");
const nav = (page: Page) => page.getByRole("navigation", { name: /^Site:/ }).filter({ visible: true });
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const rows = (page: Page) => page.getByTestId("term-row");

async function withSite(page: Page, role: Role = "owner", options: { live?: boolean } = {}) {
  const org = await seedOrganization("terms");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `terms-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  if (role !== "owner") await addMember(org.id, member.email, role);
  const [site] = await sitesIn(org.id);
  // Live before anyone has asked for a public page of it, so no cached "coming soon" is in the way.
  if (options.live) await inTenant(org.id, (c) => c.query("update sites set status = 'live' where id = $1", [site!.id]));
  return { org, site: site!, address, base: `/${org.slug}/sites/${site!.slug}` };
}
const termIdsOf = async (orgId: string, entryId: string) =>
  (await inTenant(orgId, (c) => c.query<{ term_ids: string[] }>("select term_ids from entry_drafts where entry_id = $1", [entryId]))).rows[0]!.term_ids;
const doc = (text: string) => ({ v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text }] }] } });

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("categories: add one, a subcategory under it, a slug already taken refused; rename with a new slug; delete says what it takes off first", async ({ page }) => {
  const { org, site, base } = await withSite(page, "editor");
  await nav(page).getByRole("link", { name: "Categories" }).click();
  await expect(page).toHaveURL(`${base}/posts/categories`);
  await expect(page.getByTestId("no-terms")).toContainText("This site has no categories yet.");

  const form = page.getByRole("form", { name: "Add a category" });
  await form.getByLabel("Name").fill("Bread");
  await form.getByRole("button", { name: "Add category" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("/blog/category/bread");
  await expect(form.getByLabel("Name")).toHaveValue(""); // ready for the next one
  await form.getByLabel("Name").fill("Rye");
  await form.getByLabel("Under").selectOption({ label: "Bread" });
  await form.getByLabel("Description").fill("Dark loaves");
  await form.getByRole("button", { name: "Add category" }).click();
  await expect(page.locator('[data-term="Rye"]')).toContainText("↳");
  await expect(page.locator('[data-term="Rye"]')).toContainText("Dark loaves");
  await form.getByLabel("Name").fill("More bread");
  await form.getByLabel("Slug").fill("bread");
  await form.getByRole("button", { name: "Add category" }).click();
  await expect(form.getByText("Another category of this site already uses this slug. Choose another.")).toBeVisible();
  await expect(rows(page)).toHaveCount(2);

  // A post uses Bread (published), another (a draft) too.
  const bread = (await inTenant(org.id, (c) => c.query<{ id: string }>("select id from terms where site_id = $1 and slug = 'bread'", [site.id]))).rows[0]!.id;
  const live = uuidv7();
  const draft = uuidv7();
  await seedPublishedEntry(org.id, site.id, { id: live, type: "post", title: "Live", slug: "live", path: "/blog/live", content: doc("x"), termIds: [bread] });
  await seedEntry(org.id, site.id, { id: draft, type: "post", title: "Draft", slug: "draft", path: "/blog/draft", paragraphId: uuidv7() });
  await inTenant(org.id, (c) => c.query("update entry_drafts set term_ids = $1 where entry_id = $2", [[bread], draft]));
  await page.reload();
  await expect(page.locator('[data-term="Bread"]').getByTestId("term-usage")).toHaveText("1 published post · 2 drafts");

  // Rename, with a new slug.
  await page.getByRole("button", { name: "Edit Bread" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Bread" });
  await edit.getByLabel("Name").fill("Loaves");
  await edit.getByLabel("Slug").fill("loaves");
  await expect(edit.getByLabel("Under")).toBeDisabled(); // it has a subcategory
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(page.locator('[data-term="Loaves"]')).toContainText("/blog/category/loaves");

  // Delete: the dialog says what it will be taken off; afterwards the drafts no longer hold it, the posts remain.
  await page.getByRole("button", { name: "Delete Loaves" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete Loaves?" });
  await expect(confirm).toContainText("It is taken off 1 published post and 2 drafts. The posts themselves stay.");
  await expect(confirm).toContainText("Its subcategory moves to the top level.");
  await confirm.getByRole("button", { name: "Delete category" }).click();
  await expect(page.getByText("Category Loaves deleted, and taken off 1 published post and 2 drafts.")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('[data-term="Rye"]')).not.toContainText("↳");
  expect(await termIdsOf(org.id, draft)).toEqual([]);
  expect(await termIdsOf(org.id, live)).toEqual([]);
  const posts = await inTenant(org.id, (c) => c.query("select id from entries where id = any($1)", [[live, draft]]));
  expect(posts.rowCount).toBe(2);
});

test("an Author adds a tag while writing: it is ticked and saved with the draft, and nothing typed is lost; no term screens for them", async ({ page }) => {
  const { org, site, base } = await withSite(page, "author");
  await seedTerm(org.id, site.id, "tag", "rye", "Rye");
  await page.goto(base); // drawn again for the role they now have
  await expect(nav(page).getByRole("link")).toHaveText(["Overview", "Posts", "Media"]); // the media library is an Author's too (M6-3)
  await page.goto(`${base}/posts/categories`);
  await expect(page.getByTestId("no-access")).toBeVisible();

  await page.goto(`${base}/posts/new`);
  await page.getByRole("form", { name: "New post" }).getByLabel("Title").fill("Season notes");
  await page.getByRole("button", { name: "Create post" }).click();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  const id = page.url().split("/").at(-1)!;
  const settings = page.getByTestId("entry-settings");
  // Writing, then a tag added before anything is saved: the text, the excerpt and the new tag all reach the draft.
  await editor(page).click();
  await page.keyboard.type("The first rye of the year.");
  await settings.getByLabel("Excerpt").fill("Rye is back");
  await expect(settings.getByTestId("category-choices").getByPlaceholder("New category")).toHaveCount(0); // categories: Owner–Editor
  const tags = settings.getByTestId("tag-choices");
  await tags.getByPlaceholder("New tag").fill("Seasonal");
  await tags.getByRole("button", { name: "Add" }).click();
  await expect(tags.getByLabel("Seasonal")).toBeChecked();
  await expect(page.getByText("Tag Seasonal added.")).toBeVisible();
  await expect(editor(page)).toContainText("The first rye of the year.");
  await expect(settings.getByLabel("Excerpt")).toHaveValue("Rye is back");
  const seasonal = async () => (await inTenant(org.id, (c) => c.query<{ id: string }>("select id from terms where site_id = $1 and slug = 'seasonal'", [site.id]))).rows[0]?.id;
  await expect.poll(async () => (await termIdsOf(org.id, id)).includes((await seasonal()) ?? "-"), { timeout: 15_000 }).toBe(true);
  const saved = (await inTenant(org.id, (c) => c.query<{ excerpt: string; content: unknown }>("select excerpt, content from entry_drafts where entry_id = $1", [id]))).rows[0]!;
  expect(saved.excerpt).toBe("Rye is back");
  expect(JSON.stringify(saved.content)).toContain("The first rye of the year.");

  // A name whose slug is taken still makes a tag (its slug takes a suffix); an empty one is refused there and then.
  await tags.getByPlaceholder("New tag").fill("Rye");
  await tags.getByRole("button", { name: "Add" }).click();
  await expect(tags.getByRole("checkbox")).toHaveCount(3);
  await tags.getByRole("button", { name: "Add" }).click();
  await expect(tags.getByRole("alert")).toHaveText("Enter a name.");
});

test("the public archives follow: a renamed slug moves the archive at once, the post shows the new name; deleted, the archive is gone and the post no longer shows it", async ({ page, browser }) => {
  const { org, site, address, base } = await withSite(page, "owner", { live: true });
  const other = await withSite(await (await browser.newContext()).newPage(), "owner", { live: true });
  const bread = await seedTerm(org.id, site.id, "category", "bread", "Bread");
  const theirs = await seedTerm(other.org.id, other.site.id, "category", "bread", "Their bread");
  const post = uuidv7();
  await seedPublishedEntry(org.id, site.id, { id: post, type: "post", title: "Rye season", slug: "rye-season", path: "/blog/rye-season", content: doc("Rye"), termIds: [bread] });
  await seedPublishedEntry(other.org.id, other.site.id, { id: uuidv7(), type: "post", title: "Their post", slug: "their-post", path: "/blog/their-post", content: doc("x"), termIds: [theirs] });
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();

  // Cached first: the archive, the post, and another site's archive at the same path.
  expect((await visitor.goto(`/s/${address}/blog/category/bread`))!.status()).toBe(200);
  await expect(visitor.getByRole("main")).toContainText("Rye season");
  await visitor.goto(`/s/${address}/blog/rye-season`);
  await expect(visitor.getByRole("main").getByRole("link", { name: "Bread" })).toHaveAttribute("href", `/s/${address}/blog/category/bread`);
  expect((await visitor.goto(`/s/${other.address}/blog/category/bread`))!.status()).toBe(200);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Their bread");

  // Renamed, with a new slug, in the admin.
  await page.goto(`${base}/posts/categories`);
  await page.getByRole("button", { name: "Edit Bread" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Bread" });
  await edit.getByLabel("Name").fill("Loaves");
  await edit.getByLabel("Slug").fill("loaves");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  // The old archive redirects to the new one (M8-5: a permanent redirect, sent as 308).
  const old = await visitor.request.get(`/s/${address}/blog/category/bread`, { maxRedirects: 0 });
  expect(old.status()).toBe(308);
  // Next 16 may write a fresh render's headers twice: each copy names the same address.
  expect([...new Set(old.headersArray().filter((header) => header.name.toLowerCase() === "location").map((header) => header.value))]).toEqual([`/s/${address}/blog/category/loaves`]);
  expect((await visitor.goto(`/s/${address}/blog/category/bread`))!.status()).toBe(200);
  expect(new URL(visitor.url()).pathname).toBe(`/s/${address}/blog/category/loaves`);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Loaves");
  await expect(visitor.getByRole("main")).toContainText("Rye season");
  await visitor.goto(`/s/${address}/blog/rye-season`);
  await expect(visitor.getByRole("main").getByRole("link", { name: "Loaves" })).toHaveAttribute("href", `/s/${address}/blog/category/loaves`);

  // Deleted: the archive is gone at once, the post stays and no longer shows it.
  await page.getByRole("button", { name: "Delete Loaves" }).click();
  await page.getByRole("dialog", { name: "Delete Loaves?" }).getByRole("button", { name: "Delete category" }).click();
  await expect(page.getByText(/Category Loaves deleted/)).toBeVisible();
  expect((await visitor.goto(`/s/${address}/blog/category/loaves`))!.status()).toBe(404);
  expect((await visitor.goto(`/s/${address}/blog/rye-season`))!.status()).toBe(200);
  await expect(visitor.getByRole("main")).toContainText("Rye");
  await expect(visitor.getByRole("main").getByRole("link", { name: "Loaves" })).toHaveCount(0);

  // Another site's archive at the same address was never touched.
  expect((await visitor.goto(`/s/${other.address}/blog/category/bread`))!.status()).toBe(200);
  await expect(visitor.getByRole("main")).toContainText("Their post");
  await visitorContext.close();
});

test("tags, on a phone: added, edited and deleted without the page scrolling sideways", async ({ page }) => {
  const { base } = await withSite(page, "editor");
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(`${base}/posts/tags`);
  expect(await sideways(page)).toBe(0);
  const form = page.getByRole("form", { name: "Add a tag" });
  await expect(form.getByLabel("Under")).toHaveCount(0); // tags do not nest
  await form.getByLabel("Name").fill("A very long tag name that should wrap rather than push the page wider than the phone");
  await form.getByRole("button", { name: "Add tag" }).click();
  await expect(rows(page)).toHaveCount(1);
  expect(await sideways(page)).toBe(0);
  await page.getByRole("button", { name: /^Edit A very long tag/ }).click();
  const edit = page.getByRole("dialog");
  await edit.getByLabel("Slug").fill("Not A Slug");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit.getByRole("alert")).toContainText("Use lowercase letters, numbers and single hyphens");
  await edit.getByLabel("Slug").fill("long");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(rows(page).first()).toContainText("/blog/tag/long");
  await page.getByRole("button", { name: /^Delete A very long tag/ }).click();
  await expect(page.getByRole("dialog")).toContainText("No post uses this tag.");
  await page.getByRole("dialog").getByRole("button", { name: "Delete tag" }).click();
  await expect(page.getByTestId("no-terms")).toBeVisible();
});
