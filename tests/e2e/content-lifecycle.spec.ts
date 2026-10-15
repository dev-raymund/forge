import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { homePageOf } from "./helpers/content";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf } from "./helpers/site-ui";
import { addMember, inTenant, seedUser } from "./helpers/sites";

/**
 * M7-1 end to end against the production build: unpublish, the trash, restore, deleting for good, and the warning
 * before an image in use goes to the trash. Each change is seen by a visitor on the very next request.
 */

test.describe.configure({ timeout: 120_000 });

const tail = () => randomBytes(3).toString("hex");
const editor = (page: Page) => page.getByTestId("editor");
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A member with a live site made through the form. */
async function withLiveSite(page: Page) {
  const org = await seedOrganization("life");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `life-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  await page.goto(base);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Live", { timeout: 15_000 });
  return { org, site: site!, base, address, home: (await homePageOf(org.id, site!.id))! };
}

/** A draft entry (and its draft) put in place behind the app's back, under a parent page when given. */
async function seedDraft(orgId: string, siteId: string, entry: { type: "page" | "post"; title: string; slug: string; path: string; parentId?: string }) {
  const id = uuidv7();
  const content = { v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text: `${entry.title} text.` }] }] } };
  await inTenant(orgId, async (c) => {
    await c.query("insert into entries (id, organization_id, site_id, type, locale, parent_id, title, slug, path) values ($1, $2, $3, $4, 'en', $5, $6, $7, $8)", [
      id, orgId, siteId, entry.type, entry.parentId ?? null, entry.title, entry.slug, entry.path,
    ]);
    await c.query("insert into entry_drafts (entry_id, organization_id, site_id, title, slug, content) values ($1, $2, $3, $4, $5, $6)", [id, orgId, siteId, entry.title, entry.slug, JSON.stringify(content)]);
  });
  return id;
}
const entryRow = async (orgId: string, id: string) =>
  (await inTenant(orgId, (c) => c.query<{ status: string; path: string; deleted_at: Date | null }>("select status, path, deleted_at from entries where id = $1", [id]))).rows[0] ?? null;

async function openEditor(page: Page, url: string) {
  await page.goto(url);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("unpublish a post: gone from its address, the blog and its links on the next request; its date kept; published again, back", async ({ page, browser }) => {
  const { org, site, base, address } = await withLiveSite(page);
  const id = await seedDraft(org.id, site.id, { type: "post", title: "Rye season", slug: "rye-season", path: "/blog/rye-season" });
  await openEditor(page, `${base}/posts/${id}`);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  const published = (await inTenant(org.id, (c) => c.query<{ published_at: Date }>("select published_at from entries where id = $1", [id]))).rows[0]!.published_at;

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/s/${address}/blog/rye-season`);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Rye season");
  await visitor.goto(`/s/${address}/blog`);
  await expect(visitor.getByRole("link", { name: "Rye season" })).toBeVisible();

  // The trash says why not: it is published.
  await expect(page.getByTestId("trash-blocked")).toHaveText("It is published. Unpublish it first, then move it to the trash.");
  await page.getByRole("button", { name: "Unpublish" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("It leaves the site at once");
  await dialog.getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Draft");
  await expect(page.getByText("Unpublished: it is no longer on the site.")).toBeVisible();
  expect(await entryRow(org.id, id)).toMatchObject({ status: "draft", deleted_at: null });

  await visitor.reload(); // the blog
  await expect(visitor.getByRole("link", { name: "Rye season" })).toHaveCount(0);
  const gone = await visitor.goto(`/s/${address}/blog/rye-season`);
  expect(gone?.status()).toBe(404);

  // Published again: back at once, with its first date.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  expect((await inTenant(org.id, (c) => c.query<{ published_at: Date }>("select published_at from entries where id = $1", [id]))).rows[0]!.published_at).toEqual(published);
  await visitor.reload();
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Rye season");
  await visitor.context().close();
});

test("a page and the page below it to the trash, its address free; restore refused while another page holds it, then back; deleted for good", async ({ page }) => {
  const { org, site, base } = await withLiveSite(page);
  const about = await seedDraft(org.id, site.id, { type: "page", title: "About us", slug: "about-us", path: "/about-us" });
  const team = await seedDraft(org.id, site.id, { type: "page", title: "Team", slug: "team", path: "/about-us/team", parentId: about });

  await openEditor(page, `${base}/pages/${about}`);
  const section = page.getByTestId("trash-section");
  await expect(section).toContainText("With the 1 page below it.");
  await section.getByRole("button", { name: "Move to trash…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("The 1 page below it goes with it, and comes back with it.");
  await dialog.getByRole("button", { name: "Move 2 pages to trash" }).click();
  await expect(page).toHaveURL(`${base}/pages?status=trash`);
  const item = page.getByTestId("trash-item").filter({ has: page.getByText("About us", { exact: true }) });
  await expect(item).toContainText("Was at /about-us · with 1 page below it");
  expect((await entryRow(org.id, team))!.deleted_at).not.toBeNull();
  // Not in the tree.
  await page.goto(`${base}/pages`);
  await expect(page.getByRole("link", { name: "About us", exact: true })).toHaveCount(0);

  // The address is free: a new page takes it as it is.
  const taker = await seedDraft(org.id, site.id, { type: "page", title: "About", slug: "about-us", path: "/about-us" });
  await page.goto(`${base}/pages?status=trash`);
  await item.getByRole("button", { name: "Restore" }).click();
  await expect(item.locator('[data-form-alert]')).toHaveText("The address /about-us is now used by “About”. Give that one another address, then restore this page. Nothing was restored.");
  expect((await entryRow(org.id, about))!.deleted_at).not.toBeNull();

  // That page goes to the trash too; the first comes back, with the page below it, as drafts.
  await openEditor(page, `${base}/pages/${taker}`);
  await page.getByTestId("trash-section").getByRole("button", { name: "Move to trash…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to trash" }).click();
  await expect(page).toHaveURL(`${base}/pages?status=trash`);
  await expect(page.getByTestId("trash-item")).toHaveCount(2);
  await item.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Restored as a draft at /about-us, with 1 page below it. Publish it to put it back on the site.")).toBeVisible();
  await expect(page.getByTestId("trash-item")).toHaveCount(1);
  expect(await entryRow(org.id, about)).toMatchObject({ status: "draft", path: "/about-us", deleted_at: null });
  expect(await entryRow(org.id, team)).toMatchObject({ status: "draft", path: "/about-us/team", deleted_at: null });

  // Deleted for good, after a confirmation.
  await page.getByTestId("trash-item").getByRole("button", { name: "Delete permanently…" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("This cannot be undone.");
  await confirm.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByTestId("trash-empty")).toHaveText("The trash is empty.");
  expect(await entryRow(org.id, taker)).toBeNull();
});

test("the Home page and a page with a published page below it stay out of the trash, and the editor says why", async ({ page }) => {
  const { org, site, base, home } = await withLiveSite(page);
  await openEditor(page, `${base}/pages/${home}`);
  await expect(page.getByTestId("trash-blocked")).toHaveText("This is the home page. Make another page the home page first.");
  await expect(page.getByTestId("trash-section").getByRole("button", { name: "Move to trash…" })).toBeDisabled();

  const parent = await seedDraft(org.id, site.id, { type: "page", title: "Services", slug: "services", path: "/services" });
  const child = await seedDraft(org.id, site.id, { type: "page", title: "Baking classes", slug: "baking-classes", path: "/services/baking-classes", parentId: parent });
  await openEditor(page, `${base}/pages/${child}`);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  await openEditor(page, `${base}/pages/${parent}`);
  await expect(page.getByTestId("trash-blocked")).toHaveText("A page below it is published (Baking classes). Unpublish it first.");
});

test("an image in use: the drawer says which published pages show it before it goes to the trash; the page drops it at once and gets it back on restore", async ({ page, browser }) => {
  const { org, site, base, address } = await withLiveSite(page);
  // A published post whose text holds an image of the library: uploaded through the library, put in the post's draft, published.
  await page.goto(`${base}/media`);
  const input = page.getByTestId("dropzone").getByLabel("Choose files");
  await expect(input).toBeEnabled();
  const sharp = (await import("sharp")).default;
  await input.setInputFiles([{ name: "Loaf.png", mimeType: "image/png", buffer: await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#a63" } }).png().toBuffer() }]);
  await expect(page.getByTestId("upload").and(page.locator('[data-status="ready"]'))).toHaveCount(1, { timeout: 30_000 });
  const mediaId = (await inTenant(org.id, (c) => c.query<{ id: string }>("select id from media_assets where original_filename = 'Loaf.png'"))).rows[0]!.id;
  const id = await seedDraft(org.id, site.id, { type: "post", title: "Fresh bread", slug: "fresh-bread", path: "/blog/fresh-bread" });
  const content = { v: 1, doc: { type: "doc", content: [{ type: "image", attrs: { id: uuidv7(), v: 1, mediaId, alt: "A loaf", caption: null, size: "content", link: null } }] } };
  await inTenant(org.id, (c) => c.query("update entry_drafts set content = $1 where entry_id = $2", [JSON.stringify(content), id]));
  await openEditor(page, `${base}/posts/${id}`);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/s/${address}/blog/fresh-bread`);
  await expect(visitor.locator("figure.forge-image img")).toHaveAttribute("alt", "A loaf");

  await page.goto(`${base}/media`);
  await page.locator('[data-testid="media-item"][data-name="Loaf.png"]').getByRole("button").first().click();
  const drawer = page.getByTestId("media-drawer");
  await drawer.getByRole("button", { name: "Move to trash…" }).click();
  await expect(drawer.getByTestId("media-usage")).toContainText("1 published page or post shows it: Fresh bread. They stop showing it at once.");
  await expect(drawer.getByTestId("media-usage")).toContainText("1 draft holds it: Fresh bread.");
  await expect(drawer.getByTestId("media-usage")).toContainText("It can be restored for 30 days");
  await drawer.getByTestId("trash-confirm").getByRole("button", { name: "Move to trash", exact: true }).click();
  await expect(page.getByText("Moved to the trash. 1 published page or post no longer shows it. It can be restored for 30 days.")).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Fresh bread");
  await expect(visitor.locator("figure.forge-image")).toHaveCount(0);

  await page.getByRole("link", { name: "Trash" }).click();
  await page.getByTestId("media-item").first().getByRole("button").first().click();
  await page.getByTestId("media-drawer").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("The trash is empty.")).toBeVisible();
  await visitor.reload();
  await expect(visitor.locator("figure.forge-image img")).toHaveAttribute("alt", "A loaf");
  await visitor.context().close();
});

test("the posts' trash on a phone: what is there, restore and delete, no sideways scrolling", async ({ page }) => {
  const { org, site, base } = await withLiveSite(page);
  const id = await seedDraft(org.id, site.id, { type: "post", title: "A post with a rather long title that has to wrap on a small screen", slug: "long", path: "/blog/long" });
  await page.setViewportSize({ width: 360, height: 740 });
  await openEditor(page, `${base}/posts/${id}`);
  await page.getByTestId("trash-section").getByRole("button", { name: "Move to trash…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to trash" }).click();
  await expect(page).toHaveURL(`${base}/posts?status=trash`);
  await expect(page.getByTestId("trash-item")).toHaveCount(1);
  await expect(page.getByLabel("Status")).toHaveValue("trash");
  expect(await sideways(page)).toBe(0);
  await page.getByTestId("trash-item").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("trash-empty")).toBeVisible();
  await page.goto(`${base}/posts`);
  await expect(page.getByTestId("post-row")).toHaveCount(1);
});
