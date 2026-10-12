import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { draftOf, entryOf, homePageOf, removeHomePage, seedEntry } from "./helpers/content";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf, type Role } from "./helpers/site-ui";
import { addMember, seedUser } from "./helpers/sites";

/**
 * M5-4 end to end against the production build: the entry editor. Write and
 * reload; the slash menu and the toolbar; a link to another page; two tabs;
 * hostile paste; publish; a closed tab's unsaved changes; who may; which site.
 */

const tail = () => randomBytes(3).toString("hex");
const editor = (page: Page) => page.getByTestId("editor");
const status = (page: Page) => page.getByTestId("autosave-status");
const saved = (page: Page) => expect(status(page)).toHaveText(/^Saved at/, { timeout: 15_000 });

/** A member with a site made through the form, and the site's Home page id. */
async function withSite(page: Page, role: Role = "owner") {
  const org = await seedOrganization("editor");
  await addMember(org.id, (await seedUser()).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `editor-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  if (role !== "owner") await addMember(org.id, member.email, role);
  const [site] = await sitesIn(org.id);
  const home = (await homePageOf(org.id, site!.id))!;
  return { ...member, org, address, site: site!, home, editorUrl: `/${org.slug}/sites/${site!.slug}/pages/${home}` };
}

async function openEditor(page: Page, url: string) {
  await page.goto(url);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("write the Home page: from the overview to the editor; title, text, a heading from the slash menu, bold; saved, and still there after a reload", async ({ page }) => {
  const { org, home } = await withSite(page);
  // The overview links to the Home page's editor.
  await expect(page.getByTestId("home-page-status")).toHaveText("Draft: not on the site yet");
  await page.getByTestId("home-page-link").click();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("entry-status")).toHaveText("Draft");
  await expect(status(page)).toHaveText("All changes saved");

  await page.getByTestId("entry-title").fill("Welcome to Harbour");
  await editor(page).click();
  await page.keyboard.type("Fresh bread every morning.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/head");
  const menu = page.getByTestId("slash-menu");
  await expect(menu.getByRole("option")).toHaveText(["Heading 2", "Heading 3", "Heading 4"]);
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("option", { selected: true })).toHaveText("Heading 3");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await page.keyboard.type("Our story");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Bold" }).click();
  await page.keyboard.type("Since 1902");
  await expect(status(page)).toHaveText(/Unsaved changes|Saving…|^Saved at/);
  await saved(page);

  const draft = await draftOf(org.id, home);
  expect(draft.title).toBe("Welcome to Harbour");
  expect(draft.version).toBeGreaterThan(1);
  // Read structurally: jsonb does not keep the order of an object's keys.
  const blocks = draft.content.doc.content as { type: string; attrs?: { id?: string; level?: number }; content?: { text: string; marks?: { type: string }[] }[] }[];
  expect(blocks.find((block) => block.type === "heading")).toMatchObject({ attrs: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), level: 3 }, content: [{ text: "Our story" }] });
  const texts = blocks.flatMap((block) => block.content ?? []);
  expect(texts.find((node) => node.text === "Since 1902")?.marks).toEqual([{ type: "bold" }]);

  await page.reload();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("entry-title")).toHaveValue("Welcome to Harbour");
  await expect(editor(page).locator("p").first()).toHaveText("Fresh bread every morning.");
  await expect(editor(page).locator("h3")).toHaveText("Our story");
  await expect(editor(page).locator("strong")).toHaveText("Since 1902");
});

test("a link to another page of the site, picked by title; an unsafe address is refused", async ({ page }) => {
  const { org, site, home, editorUrl } = await withSite(page);
  const about = uuidv7();
  await seedEntry(org.id, site.id, { id: about, type: "page", title: "About us", slug: "about-us", path: "/about-us", paragraphId: uuidv7() });
  await openEditor(page, editorUrl);
  await editor(page).click();
  await page.keyboard.type("Read about us");
  await page.keyboard.press("Shift+Home");
  await page.getByRole("button", { name: "Link" }).click();
  const dialog = page.getByRole("dialog", { name: "Link" });

  await dialog.getByLabel("Or an address").fill("javascript:alert(1)");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.getByText("Use a web address (https://…)")).toBeVisible();

  await dialog.getByLabel("Find a page or post").fill("about");
  await dialog.getByTestId("link-results").getByRole("button", { name: /About us/ }).click();
  await expect(dialog).toBeHidden();
  await expect(editor(page).locator(`a[href="entry:${about}"]`)).toHaveText("Read about us");
  await saved(page);
  expect(JSON.stringify((await draftOf(org.id, home)).content)).toContain(`"href":"entry:${about}"`);
});

test("two tabs: the second one's save is a conflict, not an overwrite; loading the latest version shows the first tab's text and saving works again", async ({ page, context }) => {
  const { org, home, editorUrl } = await withSite(page);
  await openEditor(page, editorUrl);
  const other = await context.newPage();
  await asUniqueVisitor(other);
  await openEditor(other, editorUrl);

  await editor(page).click();
  await page.keyboard.type("From the first tab.");
  await saved(page);

  await editor(other).click();
  await other.keyboard.type("From the second tab.");
  const dialog = other.getByTestId("conflict-dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(status(other)).toHaveText("Not saved: changed somewhere else");
  expect(JSON.stringify((await draftOf(org.id, home)).content)).not.toContain("From the second tab.");

  await other.getByRole("button", { name: "Load the latest version" }).click();
  await expect(editor(other)).toBeVisible({ timeout: 15_000 });
  await expect(editor(other)).toContainText("From the first tab.");
  await expect(other.getByTestId("conflict-dialog")).toBeHidden();
  await editor(other).click();
  await other.keyboard.press("End");
  await other.keyboard.type(" And now the second.");
  await saved(other);
  expect(JSON.stringify((await draftOf(org.id, home)).content)).toContain("From the first tab. And now the second.");
});

test("pasted hostile HTML: nothing runs, only allowed nodes are kept and saved", async ({ page }) => {
  const { org, home, editorUrl } = await withSite(page);
  await openEditor(page, editorUrl);
  await page.evaluate(() => ((window as unknown as { __xss: number }).__xss = 0));
  await editor(page).click();
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      "text/html",
      `<h1>Pasted title</h1><p>Hi<img src=x onerror="window.__xss++"><a href="javascript:window.__xss++">bad</a>
       <svg onload="window.__xss++"></svg><iframe srcdoc="<script>parent.__xss++</script>"></iframe></p>
       <div data-forge-node="button" data-label="&quot;Pay&quot;" data-href="&quot;javascript:window.__xss++&quot;"></div>`,
    );
    document.querySelector('[data-testid="editor"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(editor(page)).toContainText("Hibad");
  await expect(editor(page).locator("h2")).toHaveText("Pasted title");
  await saved(page);
  expect(await page.evaluate(() => (window as unknown as { __xss: number }).__xss)).toBe(0);
  const stored = JSON.stringify((await draftOf(org.id, home)).content);
  expect(stored).not.toMatch(/javascript:|onerror|onload|srcdoc|<script|<svg|"Pay"|button/i);
  expect(await editor(page).innerHTML()).not.toMatch(/javascript:|onerror|onload|srcdoc|<script|<svg|<iframe/i);
});

test("publish: saved first, then published; editing again shows unpublished changes", async ({ page }) => {
  const { org, home, editorUrl } = await withSite(page);
  await openEditor(page, editorUrl);
  await editor(page).click();
  await page.keyboard.type("Open every day.");
  // Publishing without waiting for autosave: it saves first.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator('[data-form-alert][role="status"]')).toContainText("Published.", { timeout: 15_000 });
  await expect(page.getByTestId("entry-status")).toHaveText("Published");
  await expect(page.getByTestId("entry-address")).toContainText("/s/");
  expect(await entryOf(org.id, home)).toMatchObject({ status: "published", path: "/", revisions: 1 });

  await editor(page).click();
  await page.keyboard.type(" Closed on Mondays.");
  await saved(page);
  await expect(page.getByTestId("entry-status")).toHaveText("Published, with unpublished changes");
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  expect((await entryOf(org.id, home)).revisions).toBe(2);
});

test("changes typed in a tab closed before they were saved are restored in the next one, and saved", async ({ page, context }) => {
  const { org, home, editorUrl } = await withSite(page);
  await openEditor(page, editorUrl);
  await editor(page).click();
  await page.keyboard.type("Typed, then the tab closed");
  // Closed at once: autosave waits 2 s, so only the local buffer has it.
  await page.close();
  const next = await context.newPage();
  await asUniqueVisitor(next);
  await openEditor(next, editorUrl);
  await expect(next.getByText("Changes that had not been saved were restored.")).toBeVisible();
  await expect(editor(next)).toContainText("Typed, then the tab closed");
  await saved(next);
  expect(JSON.stringify((await draftOf(org.id, home)).content)).toContain("Typed, then the tab closed");
});

test("a Viewer reads, cannot change: no toolbar, no Publish, nothing editable", async ({ page }) => {
  const { editorUrl } = await withSite(page, "viewer");
  await openEditor(page, editorUrl);
  await expect(page.getByTestId("read-only")).toHaveText("You can read this page but not change it.");
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Publish/ })).toHaveCount(0);
  await expect(page.getByTestId("entry-title")).toHaveAttribute("readonly", "");
});

test("only this site's entries: another organization's, another site's, the other type and non-ids are not found; the search API answers only members", async ({ page, browser, baseURL }) => {
  const mine = await withSite(page);
  const other = await browser.newContext();
  const theirsPage = await other.newPage();
  await asUniqueVisitor(theirsPage);
  const theirs = await withSite(theirsPage);
  const sibling = uuidv7();
  await seedEntry(mine.org.id, mine.site.id, { id: sibling, type: "post", title: "A post", slug: "a-post", path: "/blog/a-post", paragraphId: uuidv7() });
  const base = `/${mine.org.slug}/sites/${mine.site.slug}`;
  for (const url of [`${base}/pages/${theirs.home}`, `/${theirs.org.slug}/sites/${theirs.site.slug}/pages/${theirs.home}`, `${base}/pages/${sibling}`, `${base}/posts/${mine.home}`, `${base}/pages/not-an-id`]) {
    await page.goto(url);
    await expect(page.getByTestId("not-found").filter({ visible: true }), url).toBeVisible();
    await expect(editor(page)).toHaveCount(0);
  }
  // The post opens under /posts.
  await openEditor(page, `${base}/posts/${sibling}`);

  const search = (org: string, site: string) => page.request.get(`/api/app/entries/search?${new URLSearchParams({ org, site, q: "" })}`);
  const ok = await search(mine.org.slug, mine.site.slug);
  expect(ok.status()).toBe(200);
  expect(((await ok.json()) as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(expect.arrayContaining([mine.home, sibling]));
  expect((await search(theirs.org.slug, theirs.site.slug)).status()).toBe(404);
  expect((await search(mine.org.slug, theirs.site.slug)).status()).toBe(404);
  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(`${baseURL}/api/app/entries/search?org=${mine.org.slug}&site=${mine.site.slug}`)).status()).toBe(401);
  await Promise.all([other.close(), anonymous.close()]);
});

test("a page holding blocks this editor cannot edit yet (M5-5's) is not opened for editing, so nothing of them is lost", async ({ page }) => {
  const { org, site } = await withSite(page);
  const id = uuidv7();
  const image = { type: "image", attrs: { id: uuidv7(), v: 1, mediaId: uuidv7(), alt: null, caption: null, size: "content", link: null } };
  await seedEntry(org.id, site.id, { id, type: "page", title: "With an image", slug: "with-an-image", path: "/with-an-image", paragraphId: uuidv7(), extraBlocks: [image] });
  await page.goto(`/${org.slug}/sites/${site.slug}/pages/${id}`);
  await expect(page.getByTestId("unsupported-blocks")).toContainText("blocks this editor cannot edit yet (image)", { timeout: 15_000 });
  await expect(editor(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Publish/ })).toHaveCount(0);
  expect(JSON.stringify((await draftOf(org.id, id)).content)).toContain('"type":"image"');
});

test("a site made before Home pages existed says so on its overview; on a phone the editor fits", async ({ page }) => {
  const { org, site, editorUrl } = await withSite(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await openEditor(page, editorUrl);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
  await removeHomePage(org.id, site.id);
  await page.goto(`/${org.slug}/sites/${site.slug}`);
  await expect(page.getByTestId("home-page-missing").filter({ visible: true })).toHaveText("This site has no home page yet.");
});
