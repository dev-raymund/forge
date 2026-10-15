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
 * M5-5: the custom blocks: columns with a button, built and set in the
 * properties panel, reordered by keyboard, the block menu and dragging; a
 * video; on a phone; read-only.
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
  // ProseMirror takes a selection made by the keyboard from the browser's selectionchange, which a click sent at once
  // can overtake (as in the M5-5 tests): wait until the selection is there before asking for a link. And it may still
  // be applying the last keystrokes when Shift+Home lands, and then put its own caret back over that selection (once
  // in 70 runs on M6-1, the trace showing it empty from the first look on): select again until the selection holds.
  await expect(async () => {
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Home");
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString()), { timeout: 1_000 }).toBe("Read about us");
  }).toPass({ timeout: 10_000 });
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

test("a page holding an image the library does not have (M6-4) opens for editing: the block says so, and is kept, id and all, when the page is saved", async ({ page }) => {
  const { org, site } = await withSite(page);
  const id = uuidv7();
  const image = { type: "image", attrs: { id: uuidv7(), v: 1, mediaId: uuidv7(), alt: null, caption: null, size: "content", link: null } };
  await seedEntry(org.id, site.id, { id, type: "page", title: "With an image", slug: "with-an-image", path: "/with-an-image", paragraphId: uuidv7(), extraBlocks: [image] });
  await openEditor(page, `/${org.slug}/sites/${site.slug}/pages/${id}`);
  await expect(page.getByTestId("unsupported-blocks")).toHaveCount(0);
  await expect(editor(page).getByTestId("image-unavailable")).toHaveText("This image is no longer in the media library. It is not shown on the site. Choose another one.");
  await expect(editor(page).getByTestId("block-image").locator("img")).toHaveCount(0); // nothing is loaded for it
  await editor(page).locator("p").first().click();
  await page.keyboard.type("Edited around it.");
  await saved(page);
  const blocks = (await draftOf(org.id, id)).content.doc.content as { type: string; attrs?: { id?: string; mediaId?: string } }[];
  expect(blocks.find((block) => block.type === "image")?.attrs).toMatchObject({ id: image.attrs.id, mediaId: image.attrs.mediaId });
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

// ── M5-5: custom blocks ──────────────────────────────────────────────────────

type StoredNode = { type: string; attrs?: Record<string, unknown>; content?: StoredNode[]; text?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The editor's top-level blocks as it shows them: a custom block by its name, a text block by its tag and text. */
const order = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelector('[data-testid="editor"]')!.children]
      .filter((element) => !element.classList.contains("forge-drop-gap"))
      .map((element) => element.querySelector("[data-forge-node]")?.getAttribute("data-forge-node") ?? element.getAttribute("data-forge-node") ?? `${element.tagName.toLowerCase()}:${element.textContent}`),
  );
const idsIn = (nodes: StoredNode[]): string[] => nodes.flatMap((node) => [...(typeof node.attrs?.id === "string" ? [node.attrs.id] : []), ...idsIn(node.content ?? [])]);

/** Hovers a top-level block and waits for the drag handle to sit beside it (it is positioned asynchronously). */
async function handleFor(page: Page, block: ReturnType<Page["locator"]>) {
  await block.hover();
  const handle = page.getByTestId("drag-handle");
  await expect(handle).toBeVisible();
  await expect
    .poll(async () => {
      const [h, b] = [await handle.boundingBox(), await block.boundingBox()];
      return !!h && !!b && h.y + h.height / 2 > b.y - 2 && h.y < b.y + Math.min(b.height, 40);
    })
    .toBe(true);
  return handle;
}

test("a two-column section with a button: built from the slash menu, set in the panel, reordered by keyboard, the block menu and dragging; saved and still there after a reload", async ({ page }) => {
  const { org, home, editorUrl } = await withSite(page);
  await openEditor(page, editorUrl);
  const menu = page.getByTestId("slash-menu");
  await editor(page).click();
  await page.keyboard.type("Intro");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/two");
  await expect(menu.getByRole("option")).toHaveText(["Two columns"]);
  await page.keyboard.press("Enter");
  const columns = editor(page).getByTestId("block-columns");
  await expect(columns).toHaveCount(1);
  const column = (n: number) => columns.locator('[data-forge-node="column"]').nth(n);
  await column(0).locator("p").click();
  await page.keyboard.type("Fresh bread daily");

  // In a column the menu offers blocks, but never columns.
  await column(1).locator("p").click();
  await page.keyboard.type("/col");
  await expect(menu.getByText("Nothing matches")).toBeVisible();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("butt");
  await expect(menu.getByRole("option")).toHaveText(["Button"]);
  await page.keyboard.press("Enter");
  const button = editor(page).getByTestId("block-button");
  await expect(button).toContainText("Button");
  await expect(order(page)).resolves.toEqual(["p:Intro", "columns", "p:"]);

  // The properties panel: a change is applied only when the block is valid.
  await button.click();
  const panel = page.getByTestId("properties-panel");
  await expect(panel.getByRole("heading", { name: "Button" })).toBeVisible();
  await panel.getByLabel("Text").fill("Order now");
  await panel.getByLabel("Link").fill("javascript:alert(1)");
  await expect(panel.getByRole("alert")).toHaveText("Use an https:// address, mailto:, tel:, a path like /contact, or a page of this site.");
  await expect(panel.getByLabel("Link")).toHaveAttribute("aria-invalid", "true");
  await expect(button).toContainText("→ /");
  await panel.getByLabel("Link").fill("/order");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await panel.getByLabel("Style").selectOption("secondary");
  await expect(button).toContainText("Order now");
  await expect(button).toContainText("→ /order");
  // The columns' own settings, from its label.
  await columns.getByRole("button", { name: "Columns · 2" }).click();
  await expect(panel.getByRole("heading", { name: "Columns" })).toBeVisible();
  await panel.getByLabel("Widths").selectOption("2:1");
  await expect(columns).toHaveAttribute("style", /--forge-columns:\s*2fr 1fr/);

  // Keyboard: each Alt+↓ is its own undo step, however quick.
  await editor(page).locator("p", { hasText: "Intro" }).click();
  // ProseMirror takes a click's caret from the browser's selectionchange, which can arrive after a key sent at once:
  // the columns' panel closing says the editor has it.
  await expect(panel).toBeHidden();
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => order(page)).toEqual(["columns", "p:", "p:Intro"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => order(page)).toEqual(["columns", "p:Intro", "p:"]);
  // The toolbar's block menu, for keyboard users: the block holding the caret.
  await page.getByRole("button", { name: "Block actions" }).click();
  await page.getByRole("menu", { name: "Block actions" }).getByRole("menuitem", { name: "Move up" }).click();
  await expect.poll(() => order(page)).toEqual(["p:Intro", "columns", "p:"]);

  // The drag handle's block menu: duplicate the columns (new ids), then delete the copy.
  await (await handleFor(page, columns)).getByTestId("block-menu-button").click();
  const blockMenu = page.getByRole("menu", { name: "Block menu" });
  await expect(blockMenu.getByRole("menuitem", { name: "Move up" })).toBeEnabled();
  await blockMenu.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect.poll(() => order(page)).toEqual(["p:Intro", "columns", "columns", "p:"]);
  const stored = async () => (await draftOf(org.id, home)).content.doc.content as StoredNode[];
  await expect.poll(async () => (await stored()).filter((node) => node.type === "columns").length, { timeout: 15_000 }).toBe(2);
  const twice = await stored();
  const [first, copy] = twice.filter((node) => node.type === "columns");
  expect(idsIn([copy!]).length).toBe(idsIn([first!]).length);
  expect(idsIn([copy!]).some((id) => idsIn([first!]).includes(id))).toBe(false);
  await (await handleFor(page, columns.nth(1))).getByTestId("block-menu-button").click();
  await page.getByRole("menu", { name: "Block menu" }).getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(() => order(page)).toEqual(["p:Intro", "columns", "p:"]);

  // Dragging by the handle: a visible gap between top-level blocks, and the block lands in it.
  const handle = await handleFor(page, columns);
  const grip = (await handle.locator(".forge-drag-grip").boundingBox())!;
  const intro = (await editor(page).locator("p", { hasText: "Intro" }).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(intro.x + intro.width / 2, intro.y + 2, { steps: 12 });
  await expect(editor(page).getByTestId("drop-gap")).toBeVisible();
  await page.mouse.up();
  await expect(editor(page).getByTestId("drop-gap")).toHaveCount(0);
  await expect.poll(() => order(page)).toEqual(["columns", "p:Intro", "p:"]);

  await expect.poll(async () => (await stored()).map((node) => node.type), { timeout: 15_000 }).toEqual(["columns", "paragraph"]);
  await saved(page);
  const blocks = await stored();
  const section = blocks[0]!;
  expect(section.attrs).toMatchObject({ v: 1, count: 2, ratio: "2:1", stackOnMobile: true });
  expect(section.content![0]!.content![0]!.content![0]!.text).toBe("Fresh bread daily");
  expect(section.content![1]!.content![0]).toMatchObject({ type: "button", attrs: { v: 1, label: "Order now", href: "/order", style: "secondary", align: "start", newTab: false } });
  const ids = idsIn(blocks);
  ids.forEach((id) => expect(id).toMatch(UUID));
  expect(new Set(ids).size).toBe(ids.length);

  await page.reload();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await expect(editor(page).getByTestId("block-columns")).toHaveCount(1);
  await expect(editor(page).getByTestId("block-button")).toContainText("Order now");
  await expect.poll(() => order(page)).toEqual(["columns", "p:Intro"]);
  expect(idsIn((await draftOf(org.id, home)).content.doc.content as StoredNode[])).toEqual(ids); // reopening changes nothing
});

test("a video from the slash menu: an unsafe address is refused in the dialog; YouTube is kept, shown as an address (nothing third-party loads in the admin), and published", async ({ page }) => {
  const { org, home, editorUrl } = await withSite(page);
  await openEditor(page, editorUrl);
  await editor(page).click();
  await page.keyboard.type("/video");
  await expect(page.getByTestId("slash-menu").getByRole("option")).toHaveText(["Video or embed"]);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Video or embed" });
  const refusal = "Use a YouTube or Vimeo video address, or an https:// address of a public page.";
  for (const address of ["javascript:alert(1)", "http://www.openstreetmap.org/", "https://localhost/admin", "https://127.0.0.1/"]) {
    await dialog.getByLabel("Address").fill(address);
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(dialog.getByText(refusal), address).toBeVisible();
  }
  await expect(editor(page).getByTestId("block-embed")).toHaveCount(0);
  await dialog.getByLabel("Address").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
  const embed = editor(page).getByTestId("block-embed");
  await expect(embed).toContainText("YouTube video · 16:9");
  await expect(embed).toContainText("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(editor(page)).not.toContainText("/video");

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  const blocks = (await draftOf(org.id, home)).content.doc.content as StoredNode[];
  expect(blocks.find((node) => node.type === "embed")).toMatchObject({ attrs: { v: 1, provider: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", aspect: "16:9" } });
});

/** A page with a two-column section holding a button, made behind the app's back. */
async function seedSection(orgId: string, siteId: string) {
  const id = uuidv7();
  const section = {
    type: "columns",
    attrs: { id: uuidv7(), v: 1, count: 2, ratio: "1:1", stackOnMobile: true },
    content: [
      { type: "column", attrs: { id: uuidv7() }, content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text: "Left side" }] }] },
      { type: "column", attrs: { id: uuidv7() }, content: [{ type: "button", attrs: { id: uuidv7(), v: 1, label: "Call us", href: "tel:+15550100", style: "primary", align: "start", newTab: false } }] },
    ],
  };
  await seedEntry(orgId, siteId, { id, type: "page", title: "Sections", slug: "sections", path: "/sections", paragraphId: uuidv7(), extraBlocks: [section, { type: "spacer", attrs: { id: uuidv7(), v: 1, size: "md" } }] });
  return id;
}

test("opening a page that ends with a block and clicking around saves nothing (no new version, no conflict for another tab); an edit does", async ({ page }) => {
  const { org, site } = await withSite(page);
  const id = await seedSection(org.id, site.id);
  await openEditor(page, `/${org.slug}/sites/${site.slug}/pages/${id}`);
  await editor(page).getByTestId("block-button").click();
  await editor(page).locator("p", { hasText: "Left side" }).click();
  await editor(page).getByTestId("block-spacer").click();
  // Autosave waits 2 s after a change: give it time to (wrongly) save.
  await page.waitForTimeout(3_000);
  await expect(status(page)).toHaveText("All changes saved");
  expect((await draftOf(org.id, id)).version).toBe(1);

  await editor(page).locator("p", { hasText: "Left side" }).click();
  // The editor has taken the click (see the keyboard test above) when the panel is the columns' rather than the spacer's.
  await expect(page.getByTestId("properties-panel").getByRole("heading")).toHaveText("Columns");
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await expect.poll(async () => (await draftOf(org.id, id)).version, { timeout: 15_000 }).toBe(2);
  const content = JSON.stringify((await draftOf(org.id, id)).content);
  expect(content).toContain("Left side and more");
  expect(content).toContain('"type":"spacer"');
});

test("on a phone the columns stack, the page does not scroll sideways, and the panel stays in view at the bottom", async ({ page }) => {
  const { org, site } = await withSite(page);
  const id = await seedSection(org.id, site.id);
  await page.setViewportSize({ width: 360, height: 740 });
  await openEditor(page, `/${org.slug}/sites/${site.slug}/pages/${id}`);
  const columns = editor(page).getByTestId("block-columns").locator('[data-forge-node="column"]');
  const [left, right] = [(await columns.nth(0).boundingBox())!, (await columns.nth(1).boundingBox())!];
  expect(right.y).toBeGreaterThanOrEqual(left.y + left.height - 1);
  await editor(page).getByTestId("block-button").click();
  const panel = page.getByTestId("properties-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("Text")).toHaveValue("Call us");
  // The panel scrolls inside a sheet kept at the bottom of the screen.
  const sheet = (await panel.locator("xpath=..").boundingBox())!;
  expect(sheet.width).toBeLessThanOrEqual(360);
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(740 + 1);
  expect(sheet.height).toBeLessThanOrEqual(740 / 2);
  await panel.getByLabel("Text").fill("Call us today");
  await expect(editor(page).getByTestId("block-button")).toContainText("Call us today");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test("a Viewer sees the blocks but cannot change them: no handle, no block menu, no panel", async ({ page }) => {
  const { org, site } = await withSite(page, "viewer");
  const id = await seedSection(org.id, site.id);
  await openEditor(page, `/${org.slug}/sites/${site.slug}/pages/${id}`);
  await expect(page.getByTestId("read-only")).toBeVisible();
  await expect(editor(page).getByTestId("block-button")).toContainText("Call us");
  await editor(page).getByTestId("block-columns").hover();
  await editor(page).getByTestId("block-button").click();
  await expect(page.getByTestId("drag-handle")).toHaveCount(0);
  await expect(page.getByTestId("properties-panel")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Block actions" })).toHaveCount(0);
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => order(page)).toEqual(["p:", "columns", "spacer", "p:"]); // nothing moved
});
