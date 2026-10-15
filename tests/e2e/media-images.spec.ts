import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { draftOf, homePageOf, seedEntry } from "./helpers/content";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf, type Role } from "./helpers/site-ui";
import { addMember, inTenant, seedUser } from "./helpers/sites";

/**
 * M6-4 end to end against the production build, with the local storage driver: images in use. The picker (with its
 * own upload), the image block from the slash menu and the properties panel, published and drawn on the live site
 * from its variants under /media; trashed and restored; a post's featured image; the site's logo and favicon; a PDF
 * in the browser; a phone.
 */

test.skip(!!process.env.E2E_BASE_URL, "uploads here go to the local storage driver's route");
// Each test uploads, processes, publishes and visits: longer than the default 30 s.
test.describe.configure({ timeout: 120_000 });

const tail = () => randomBytes(3).toString("hex");
const editor = (page: Page) => page.getByTestId("editor");
const status = (page: Page) => page.getByTestId("autosave-status");
const saved = (page: Page) => expect(status(page)).toHaveText(/^Saved at/, { timeout: 15_000 });
const picker = (page: Page) => page.getByTestId("media-picker");
const blockPanel = (page: Page) => page.getByTestId("properties-panel");
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const png = async (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
const PDF = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n${" ".repeat(400)}`);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A member with a site made through the form; the site is live, so a visitor sees what is published. */
async function withLiveSite(page: Page, role: Role = "owner") {
  const org = await seedOrganization("images");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `images-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  const [site] = await sitesIn(org.id);
  const base = `/${org.slug}/sites/${site!.slug}`;
  await page.goto(base);
  await page.getByRole("button", { name: "Publish site…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish site" }).click();
  await expect(page.getByTestId("site-status").filter({ visible: true })).toHaveText("Live", { timeout: 15_000 });
  if (role !== "owner") await addMember(org.id, member.email, role);
  const home = (await homePageOf(org.id, site!.id))!;
  return { org, site: site!, base, address, home, editorUrl: `${base}/pages/${home}` };
}

/** Uploads through the library's dropzone and waits until the server says each file is ready. */
async function uploadInLibrary(page: Page, base: string, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.goto(`${base}/media`);
  const input = page.getByTestId("dropzone").getByLabel("Choose files");
  await expect(input).toBeEnabled();
  await input.setInputFiles(files);
  await expect(page.getByTestId("upload").and(page.locator('[data-status="ready"]'))).toHaveCount(files.length, { timeout: 30_000 });
}
const mediaIdOf = async (orgId: string, filename: string) =>
  (await inTenant(orgId, (c) => c.query<{ id: string }>("select id from media_assets where original_filename = $1 order by created_at desc limit 1", [filename]))).rows[0]!.id;
const variantsOf = async (orgId: string, id: string) =>
  (await inTenant(orgId, (c) => c.query<{ variants: { key: string; storageKey: string; width: number }[]; storage_key: string }>("select variants, storage_key from media_assets where id = $1", [id]))).rows[0]!;

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("an image from the slash menu and the picker (uploaded there; a PDF refused), set in the panel; saved, reloaded, published → live srcset from /media; trashed → gone at once; restored → back", async ({ page, browser }) => {
  const { org, base, address, home, editorUrl } = await withLiveSite(page);
  await page.goto(editorUrl);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await editor(page).click();
  await page.keyboard.type("Our bakery.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/image");
  await expect(page.getByTestId("slash-menu").getByRole("option", { selected: true })).toHaveText("Image");
  await page.keyboard.press("Enter");

  // The picker: nothing yet; uploaded from inside it (the same upload service), a PDF refused before it is sent.
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).getByRole("heading", { name: "Insert an image" })).toBeVisible();
  await expect(picker(page).getByTestId("picker-empty")).toHaveText("This site has no images yet. Upload one below.");
  await picker(page).getByText("Upload new images").click();
  const input = picker(page).getByTestId("dropzone").getByLabel("Choose files");
  await expect(input).toBeEnabled();
  await expect(input).toHaveAttribute("accept", /image\/png/);
  await input.setInputFiles([
    { name: "Rye loaf.png", mimeType: "image/png", buffer: await png(1800, 1200, "#a63") },
    { name: "Menu.pdf", mimeType: "application/pdf", buffer: PDF },
  ]);
  await expect(picker(page).getByTestId("upload").and(page.locator('[data-name="Menu.pdf"]'))).toHaveAttribute("data-status", "refused");
  const item = picker(page).getByRole("button", { name: "Choose Rye loaf.png" });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(picker(page).getByTestId("picker-item")).toHaveCount(1); // images only
  await item.click();
  await expect(picker(page)).toBeHidden();

  // The block: the thumbnail (a variant from /media), selected, set in the panel.
  const block = editor(page).getByTestId("block-image");
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("Image · Text width · Rye loaf.png");
  await expect(block.locator("img")).toHaveAttribute("src", /\/media\/o\/.+\/thumb\/rye-loaf\.webp$/);
  await block.click();
  const panel = blockPanel(page);
  await expect(panel.getByRole("heading", { name: "Image" })).toBeVisible();
  await panel.getByLabel("Alternative text").fill("A rye loaf on the counter");
  await panel.getByLabel("Caption").fill("Baked this morning");
  await panel.getByLabel("Size").selectOption("wide");
  await saved(page);

  const mediaId = await mediaIdOf(org.id, "Rye loaf.png");
  type Node = { type: string; attrs?: Record<string, unknown> };
  const imageIn = async () => ((await draftOf(org.id, home)).content.doc.content as Node[]).find((node) => node.type === "image")!;
  const stored = await imageIn();
  expect(stored.attrs).toMatchObject({ mediaId, alt: "A rye loaf on the counter", caption: "Baked this morning", size: "wide", link: null, v: 1 });
  expect(stored.attrs!.id).toMatch(UUID_V7);

  // Reloaded: the same block, the same id. No thumbnail is loaded until asked for; clicking around changes nothing
  // and saves nothing.
  const media: string[] = [];
  page.on("request", (request) => void (request.url().includes("/media/") && media.push(request.url())));
  await page.reload();
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await expect(editor(page).getByTestId("block-image")).toHaveAttribute("data-media-id", mediaId);
  await expect(editor(page).getByTestId("block-image")).toContainText("Image · Wide · Rye loaf.png");
  await expect(editor(page).getByTestId("block-image").locator("img")).toHaveCount(0);
  expect(media).toEqual([]);
  await editor(page).getByTestId("show-image-previews").click();
  await expect(editor(page).getByTestId("block-image").locator("img")).toHaveAttribute("src", /\/thumb\/rye-loaf\.webp$/);
  expect(media.every((url) => /\/thumb\/rye-loaf\.webp$/.test(url))).toBe(true);
  const version = (await draftOf(org.id, home)).version;
  await editor(page).getByTestId("block-image").click();
  await blockPanel(page).getByRole("button", { name: "Choose another image" }).click();
  await expect(picker(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();
  await expect(status(page)).toHaveText("All changes saved");
  expect((await draftOf(org.id, home)).version).toBe(version);
  expect((await imageIn()).attrs!.id).toBe(stored.attrs!.id);

  // Published: the live page draws it from the image's widths under /media, never its original.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/s/${address}`);
  const figure = visitor.locator("figure.forge-image.forge-image--wide");
  await expect(figure).toHaveCount(1);
  const img = figure.locator("img");
  const { variants, storage_key: original } = await variantsOf(org.id, mediaId);
  const widths = variants.filter((v) => /^w\d+$/.test(v.key));
  expect(widths.map((v) => v.key)).toEqual(["w800", "w1600"]);
  // The media base is the app's origin (`/media`) here; a CDN in front of it would be MEDIA_PUBLIC_BASE_URL.
  expect(await img.getAttribute("srcset")).toBe(widths.map((v) => `${new URL(visitor.url()).origin}/media/${v.storageKey} ${v.width}w`).join(", "));
  await expect(img).toHaveAttribute("alt", "A rye loaf on the counter");
  await expect(img).toHaveAttribute("width", "1800");
  await expect(img).toHaveAttribute("height", "1200");
  await expect(figure.locator("figcaption")).toHaveText("Baked this morning");
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
  expect(await img.evaluate((el) => (el as HTMLImageElement).currentSrc)).toMatch(/\/media\/o\/.+\/w(800|1600)\/rye-loaf\.webp$/);
  expect(await visitor.content()).not.toContain(original);
  for (const variant of widths) {
    const response = await visitor.request.get(`/media/${variant.storageKey}`);
    expect(response.status()).toBe(200);
    expect(response.headers()).toMatchObject({ "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable" });
  }
  expect((await visitor.request.get(`/media/${original}`)).status()).toBe(404);

  // Trashed in the library: gone from the live page on the next request, the rest of the page still there.
  await page.goto(`${base}/media`);
  await page.locator('[data-testid="media-item"][data-name="Rye loaf.png"]').getByRole("button").first().click();
  await page.getByTestId("media-drawer").getByRole("button", { name: "Move to trash" }).click();
  await expect(page.getByTestId("media-item")).toHaveCount(0);
  await visitor.reload();
  await expect(visitor.getByRole("main")).toContainText("Our bakery.");
  await expect(visitor.locator("figure.forge-image")).toHaveCount(0);
  expect((await visitor.request.get(`/media/${widths[0]!.storageKey}`)).status()).toBe(404);
  // The editor says so, and keeps the block.
  await page.goto(editorUrl);
  await expect(editor(page).getByTestId("image-unavailable")).toBeVisible({ timeout: 15_000 });

  // Restored: back on the next request.
  await page.goto(`${base}/media`);
  await page.getByRole("link", { name: "Trash" }).click();
  await page.getByTestId("media-item").first().getByRole("button").first().click();
  await page.getByTestId("media-drawer").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("The trash is empty.")).toBeVisible();
  await visitor.reload();
  await expect(visitor.locator("figure.forge-image img")).toHaveAttribute("alt", "A rye loaf on the counter");
  await visitor.context().close();
});

test("a post's featured image: chosen in the sidebar, saved with the draft, published, drawn above the post in Studio and in Journal; removed", async ({ page, browser }) => {
  const { org, site, base, address } = await withLiveSite(page);
  await uploadInLibrary(page, base, [{ name: "Cover.png", mimeType: "image/png", buffer: await png(2000, 1000, "#358") }]);
  const post = uuidv7();
  await seedEntry(org.id, site.id, { id: post, type: "post", title: "Rye season", slug: "rye-season", path: "/blog/rye-season", paragraphId: uuidv7() });
  await page.goto(`${base}/posts/${post}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });

  const slot = page.getByTestId("featured-image");
  await expect(slot).toContainText("None. The post is shown without one.");
  await slot.getByRole("button", { name: "Choose an image" }).click();
  await expect(picker(page).getByRole("heading", { name: "Choose a featured image" })).toBeVisible();
  await picker(page).getByRole("button", { name: "Choose Cover.png" }).click();
  await expect(slot.getByTestId("featured-image-preview")).toHaveAttribute("src", /\/thumb\/cover\.webp$/);
  await saved(page);
  const mediaId = await mediaIdOf(org.id, "Cover.png");
  expect((await inTenant(org.id, (c) => c.query<{ featured_media_id: string }>("select featured_media_id from entry_drafts where entry_id = $1", [post]))).rows[0]!.featured_media_id).toBe(mediaId);

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/s/${address}/blog/rye-season`);
  const featured = visitor.locator("figure.forge-featured-image img");
  await expect(featured).toHaveAttribute("srcset", /\/w800\/cover\.webp 800w, .+\/w1600\/cover\.webp 1600w$/);
  await expect(featured).toHaveAttribute("loading", "eager");
  await expect.poll(() => featured.evaluate((el) => (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
  // Above the post's text.
  expect(await visitor.evaluate(() => {
    const figure = document.querySelector("figure.forge-featured-image")!;
    const title = document.querySelector("h1")!;
    return !!(title.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);

  // Journal draws it too.
  await page.goto(`${base}/appearance`);
  await page.getByRole("form", { name: "Theme" }).locator('[data-theme-key="journal"]').click();
  await page.getByRole("button", { name: "Use this theme" }).click();
  await expect(page.locator('[data-form-alert][role="status"]').filter({ visible: true })).toHaveText("The site now uses Journal.");
  await visitor.reload();
  await expect(visitor.locator("[data-forge-theme]")).toHaveAttribute("data-theme", "journal");
  await expect(visitor.locator("figure.forge-featured-image img")).toHaveAttribute("srcset", /\/w1600\/cover\.webp 1600w$/);

  // Removed, and published again: gone.
  await page.goto(`${base}/posts/${post}`);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("featured-image").getByRole("button", { name: "Remove" }).click();
  await saved(page);
  await page.getByRole("button", { name: "Publish changes" }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });
  await visitor.reload();
  await expect(visitor.locator("figure.forge-featured-image")).toHaveCount(0);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Rye season");
  await visitor.context().close();
});

test("the site's logo and favicon from its settings: the header shows the logo, the page links the favicons (PNG, from /media); removed again", async ({ page, browser }) => {
  const { base, address } = await withLiveSite(page);
  await uploadInLibrary(page, base, [
    { name: "Logo.png", mimeType: "image/png", buffer: await png(1200, 300, "#123") },
    { name: "Icon.png", mimeType: "image/png", buffer: await png(512, 512, "#c33") },
  ]);
  await page.goto(`${base}/settings`);
  const logo = page.getByTestId("site-logo");
  await expect(logo).toContainText("None. The header shows the site's name.");
  await logo.getByRole("button", { name: "Choose a logo" }).click();
  await expect(picker(page).getByRole("heading", { name: "Choose a logo" })).toBeVisible();
  await picker(page).getByRole("button", { name: "Choose Logo.png" }).click();
  await expect(logo.locator("[data-form-alert]")).toHaveText("Logo saved.");
  await expect(logo.getByTestId("site-logo-preview")).toBeVisible();
  const favicon = page.getByTestId("site-favicon");
  await favicon.getByRole("button", { name: "Choose a favicon" }).click();
  await picker(page).getByRole("button", { name: "Choose Icon.png" }).click();
  await expect(favicon.locator("[data-form-alert]")).toHaveText("Favicon saved.");

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/s/${address}`);
  const brand = visitor.getByRole("banner").locator("img.forge-logo");
  await expect(brand).toHaveAttribute("src", /\/media\/o\/.+\/logo\/logo\.webp$/);
  await expect(brand).toHaveAttribute("alt", "Harbour Bakery");
  await expect(brand).toHaveAttribute("width", "640");
  await expect(brand).toHaveAttribute("height", "160");
  await expect.poll(() => brand.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(640);
  const icon = visitor.locator('link[rel="icon"][sizes="32x32"]');
  await expect(icon).toHaveAttribute("href", /\/media\/o\/.+\/fav32\/icon\.png$/);
  await expect(icon).toHaveAttribute("type", "image/png");
  await expect(visitor.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /\/fav180\/icon\.png$/);
  const served = await visitor.request.get((await icon.getAttribute("href"))!);
  expect([served.status(), served.headers()["content-type"]]).toEqual([200, "image/png"]);
  expect((await sharp(await served.body()).metadata())).toMatchObject({ format: "png", width: 32, height: 32 });

  // Removed: the header shows the name again, on the next request.
  await logo.getByRole("button", { name: "Remove logo" }).click();
  await expect(logo.locator("[data-form-alert]")).toHaveText("Logo removed.");
  await visitor.reload();
  await expect(visitor.getByRole("banner").locator("img.forge-logo")).toHaveCount(0);
  await expect(visitor.getByRole("banner")).toContainText("Harbour Bakery");
  await expect(visitor.locator('link[rel="icon"][sizes="32x32"]')).toHaveCount(1);
  await visitor.context().close();
});

test("a PDF in the browser: served as itself (inline, sandboxed); the drawer also offers it as a download", async ({ page }) => {
  const { base } = await withLiveSite(page, "editor");
  await uploadInLibrary(page, base, [{ name: "Price list.pdf", mimeType: "application/pdf", buffer: PDF }]);
  await page.locator('[data-testid="media-item"][data-name="Price list.pdf"]').getByRole("button").first().click();
  const drawer = page.getByTestId("media-drawer");
  const url = await drawer.getByTestId("media-url").inputValue();
  expect(url).toMatch(/\/media\/o\/.+\/original\/price-list\.pdf$/);

  const response = await page.request.get(url);
  expect(response.headers()).toMatchObject({
    "content-type": "application/pdf", "content-disposition": 'inline; filename="price-list.pdf"', "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff",
  });

  // What this browser does when the file is opened (ADR 0023 §9): Playwright's Chromium (headless) downloads the PDF
  // rather than showing it, so the visitor still gets the file. The security headers are not loosened for a viewer.
  const opened = await page.context().newPage();
  const download = opened.waitForEvent("download", { timeout: 10_000 });
  await opened.goto(url).catch(() => {}); // a navigation that becomes a download is reported as aborted
  const got = await download;
  expect(got.suggestedFilename()).toBe("price-list.pdf");
  expect((await got.path()) && (await readFile((await got.path())!)).subarray(0, 5).toString()).toBe("%PDF-");
  await opened.close();

  // The drawer's fallback: the file itself. The server's own file name wins over the link's.
  const [file] = await Promise.all([page.waitForEvent("download"), drawer.getByRole("link", { name: "Download" }).click()]);
  expect(file.suggestedFilename()).toBe("price-list.pdf");
});

test("on a phone: the picker by keyboard, the image within the screen, no sideways scrolling, in Studio", async ({ page, browser }) => {
  const { org, base, address, home, editorUrl } = await withLiveSite(page);
  await uploadInLibrary(page, base, [{ name: "Wide view.png", mimeType: "image/png", buffer: await png(2400, 800, "#596") }]);
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(editorUrl);
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
  await editor(page).click();
  await page.keyboard.type("/image");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toBeVisible();
  const choice = picker(page).getByRole("button", { name: "Choose Wide view.png" });
  await expect(choice).toBeVisible();
  await choice.focus();
  await page.keyboard.press("Enter");
  await expect(picker(page)).toBeHidden();
  await expect(editor(page).getByTestId("block-image")).toContainText("Wide view.png");
  expect(await sideways(page)).toBe(0);
  await editor(page).getByTestId("block-image").click();
  await blockPanel(page).getByLabel("Size").selectOption("full");
  await saved(page);
  expect(JSON.stringify((await draftOf(org.id, home)).content)).toContain('"size":"full"');
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("entry-status")).toHaveText("Published", { timeout: 15_000 });

  const phone = await (await browser.newContext({ viewport: { width: 360, height: 740 } })).newPage();
  await phone.goto(`/s/${address}`);
  const img = phone.locator("figure.forge-image--full img");
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
  // The browser chose the narrow width for a narrow screen, and the image fits it.
  expect(await img.evaluate((el) => (el as HTMLImageElement).currentSrc)).toMatch(/\/w800\/wide-view\.webp$/);
  const box = (await img.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await sideways(phone)).toBe(0);
  await phone.context().close();
});
