import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { uuidv7 } from "uuidv7";
import { asUniqueVisitor } from "./helpers/auth";
import { markEmailVerified, seedOrganization, sitesIn } from "./helpers/orgs";
import { createSite, expectSiteCreated, memberOf, type Role } from "./helpers/site-ui";
import { addMember, inTenant, seedUser } from "./helpers/sites";

/**
 * M6-3 end to end against the production build, with the local storage driver: the media library. Files go from the
 * browser straight to the storage target, the server checks and processes them, and only then does the library show
 * them. Folders, search, the drawer, the trash; who may do what; a phone.
 */

test.skip(!!process.env.E2E_BASE_URL, "uploads here go to the local storage driver's route");

const tail = () => randomBytes(3).toString("hex");
const nav = (page: Page) => page.getByRole("navigation", { name: /^Site:/ }).filter({ visible: true });
const items = (page: Page) => page.getByTestId("media-item");
const uploads = (page: Page) => page.getByTestId("upload");
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const image = async (format: "png" | "jpeg" | "webp", width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } })[format]().toBuffer();
const PDF = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n${" ".repeat(400)}`);

async function withSite(page: Page, role: Role = "owner") {
  const org = await seedOrganization("media");
  await addMember(org.id, (await seedUser("Olive Owner")).email, "owner");
  const member = await memberOf(page, "owner", org);
  await markEmailVerified(member.email);
  const address = `media-${tail()}`;
  await page.goto(`/${org.slug}/sites/new`);
  await createSite(page, { name: "Harbour Bakery", address });
  await expectSiteCreated(page, org.slug, address);
  if (role !== "owner") await addMember(org.id, member.email, role);
  const [site] = await sitesIn(org.id);
  return { org, site: site!, base: `/${org.slug}/sites/${site!.slug}` };
}
async function choose(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const input = page.getByTestId("dropzone").getByLabel("Choose files");
  await expect(input).toBeEnabled(); // usable once the page is interactive
  await input.setInputFiles(files);
}
const waitReady = (page: Page, count: number) => expect(uploads(page).and(page.locator('[data-status="ready"]'))).toHaveCount(count, { timeout: 30_000 });

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("upload three images and a PDF, search, move to a folder, trash and restore", async ({ page }) => {
  const { base } = await withSite(page, "editor");
  await nav(page).getByRole("link", { name: "Media" }).click();
  await expect(page).toHaveURL(`${base}/media`);
  await expect(page.getByTestId("no-media")).toHaveText("No files yet. Upload the first ones above.");
  await expect(page.getByTestId("storage-usage")).toHaveText(/^0 bytes of 20 GiB used on the Pro plan$/);

  await choose(page, [
    { name: "Beach at dusk.png", mimeType: "image/png", buffer: await image("png", 1200, 800, "#e85") },
    { name: "harbour.jpg", mimeType: "image/jpeg", buffer: await image("jpeg", 900, 600, "#358") },
    { name: "bread.webp", mimeType: "image/webp", buffer: await image("webp", 640, 640, "#a63") },
    { name: "Menu.pdf", mimeType: "application/pdf", buffer: PDF },
  ]);
  await waitReady(page, 4);
  await expect(page.getByTestId("upload-summary")).toHaveText("4 ready");
  await expect(items(page)).toHaveCount(4);
  // Thumbnails are the square variant from /media, never the original; the PDF has none.
  const thumbs = page.getByTestId("media-thumb");
  await expect(thumbs).toHaveCount(3);
  for (const src of await thumbs.evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).src))) expect(src).toMatch(/\/media\/o\/.+\/thumb\/[a-z0-9-]+\.webp$/);
  await expect.poll(() => thumbs.evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(page.getByTestId("media-pdf")).toHaveCount(1);
  await expect(page.getByTestId("storage-usage")).toHaveText(/ (KiB|MiB) of 20 GiB used on the Pro plan$/);

  // Search.
  const search = page.getByRole("search", { name: "Search the media" });
  await search.getByLabel("Search").fill("beach");
  await search.getByRole("button", { name: "Apply" }).click();
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toHaveAttribute("data-name", "Beach at dusk.png");
  await search.getByLabel("Search").fill("");
  await search.getByLabel("Kind").selectOption({ label: "PDFs" });
  await search.getByRole("button", { name: "Apply" }).click();
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toHaveAttribute("data-name", "Menu.pdf");
  await page.goto(`${base}/media`);

  // A folder, and a file moved into it from its drawer.
  const folders = page.getByRole("navigation", { name: "Folders" });
  await folders.getByLabel("New folder").fill("Events");
  await folders.getByRole("button", { name: "Create folder" }).click();
  await expect(folders.getByTestId("folder")).toHaveCount(1);
  await page.locator('[data-testid="media-item"][data-name="harbour.jpg"]').getByRole("button").first().click();
  const drawer = page.getByTestId("media-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("media-preview")).toHaveAttribute("src", /\/w800\/harbour\.webp$/);
  await expect(drawer.getByTestId("media-url")).toHaveValue(/\/w800\/harbour\.webp$/); // its widest variant: 900 wide → 800
  await drawer.getByLabel("Alternative text").fill("Boats in the harbour");
  await drawer.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Details saved.")).toBeVisible();
  await drawer.getByLabel("Folder", { exact: true }).selectOption({ label: "Events" });
  await drawer.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByText("1 file moved.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(folders.getByTestId("folder").first()).toContainText("1");
  await folders.getByRole("link", { name: /Events/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Events" })).toBeVisible();
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toHaveAttribute("data-name", "harbour.jpg");

  // Trash, and restore.
  await items(page).first().getByRole("button").first().click();
  await drawer.getByRole("button", { name: "Move to trash" }).click();
  await expect(items(page)).toHaveCount(0);
  await page.getByRole("link", { name: "Trash" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Trash" })).toBeVisible();
  await expect(items(page)).toHaveCount(1);
  await items(page).first().getByRole("button").first().click();
  await drawer.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("The trash is empty.")).toBeVisible();
  await page.getByRole("link", { name: "Back to the library" }).click();
  await expect(items(page)).toHaveCount(4);
});

test("into a folder chosen on upload; a file refused before it is sent, one refused by the server; a failed send retried", async ({ page }) => {
  const { org, site, base } = await withSite(page);
  const folderId = uuidv7();
  await inTenant(org.id, (c) => c.query("insert into media_folders (id, organization_id, site_id, name) values ($1, $2, $3, 'Docs')", [folderId, org.id, site.id]));
  await page.goto(`${base}/media`);
  await page.getByTestId("dropzone").getByLabel("Into").selectOption({ label: "Docs" });

  // The first send to storage fails (the network), then works.
  let failOnce = true;
  await page.route("**/api/storage/local/**", (route) => {
    if (!failOnce) return route.continue();
    failOnce = false;
    return route.abort();
  });
  await choose(page, [
    { name: "price-list.pdf", mimeType: "application/pdf", buffer: PDF },
    { name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") },
  ]);
  const svg = uploads(page).and(page.locator('[data-name="logo.svg"]'));
  await expect(svg).toHaveAttribute("data-status", "refused");
  await expect(svg).toContainText("logo.svg can't be uploaded. Upload JPEG, PNG, WebP, GIF or PDF files.");
  const pdf = uploads(page).and(page.locator('[data-name="price-list.pdf"]'));
  await expect(pdf).toHaveAttribute("data-status", "failed");
  await expect(pdf).toContainText("The file did not reach storage. Try again.");
  await pdf.getByRole("button", { name: "Try again: price-list.pdf" }).click();
  await expect(pdf).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await page.unroute("**/api/storage/local/**");

  // Sent as a PNG, is HTML: the server refuses it with the reason, and it never shows in the library.
  await choose(page, [{ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(`<!doctype html><script>alert(1)</script>${" ".repeat(300)}`) }]);
  const fake = uploads(page).and(page.locator('[data-name="photo.png"]'));
  await expect(fake).toHaveAttribute("data-status", "refused", { timeout: 30_000 });
  await expect(fake).toContainText("photo.png is not a PNG file.");
  await expect(fake.getByRole("button", { name: /Try again/ })).toHaveCount(0);

  await page.getByRole("navigation", { name: "Folders" }).getByRole("link", { name: /Docs/ }).click();
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first()).toHaveAttribute("data-name", "price-list.pdf");
  const [row] = (await inTenant(org.id, (c) => c.query<{ folder_id: string; status: string }>("select folder_id, status from media_assets where site_id = $1 and original_filename = 'price-list.pdf'", [site.id]))).rows;
  expect(row).toEqual({ folder_id: folderId, status: "ready" });
});

test("an Author uploads and changes only their own; a Viewer has no media library", async ({ page, browser }) => {
  const { org, site, base } = await withSite(page, "author");
  // A file someone else uploaded (a PDF: nothing to draw).
  const owner = await seedUser("Olga Other");
  await addMember(org.id, owner.email, "editor");
  await inTenant(org.id, (c) =>
    c.query(
      "insert into media_assets (id, organization_id, site_id, kind, status, storage_key, original_filename, mime_type, size_bytes, uploaded_by) values ($1, $2, $3, 'document', 'ready', $4, 'theirs.pdf', 'application/pdf', 500, $5)",
      [uuidv7(), org.id, site.id, `o/${org.id}/s/${site.id}/m/${uuidv7()}/v1/original/theirs.pdf`, owner.id],
    ),
  );
  await page.goto(`${base}/media`);
  await expect(page.getByRole("navigation", { name: "Folders" }).getByLabel("New folder")).toHaveCount(0);
  await choose(page, [{ name: "mine.png", mimeType: "image/png", buffer: await image("png", 500, 500, "#2a6") }]);
  await waitReady(page, 1);
  await expect(items(page)).toHaveCount(2);

  await page.locator('[data-testid="media-item"][data-name="theirs.pdf"]').getByRole("button").first().click();
  const drawer = page.getByTestId("media-drawer");
  await expect(drawer).toContainText("Only its uploader or an editor can change this file.");
  await expect(drawer.getByLabel("Title")).toBeDisabled();
  await expect(drawer.getByRole("button", { name: "Move to trash" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="media-item"][data-name="mine.png"]').getByRole("button").first().click();
  await drawer.getByLabel("Title").fill("My loaf");
  await drawer.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Details saved.")).toBeVisible();

  const viewerPage = await (await browser.newContext()).newPage();
  await asUniqueVisitor(viewerPage);
  const viewer = await memberOf(viewerPage, "viewer", org);
  await markEmailVerified(viewer.email);
  await viewerPage.goto(base);
  await expect(nav(viewerPage).getByRole("link", { name: "Media" })).toHaveCount(0);
  await viewerPage.goto(`${base}/media`);
  await expect(viewerPage.getByTestId("no-access")).toContainText("Owners, Admins, Editors and Authors");
  await viewerPage.context().close();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test("the library fits the screen; a file opens and closes from the keyboard", async ({ page }) => {
    const { base } = await withSite(page);
    await page.goto(`${base}/media`);
    await choose(page, [{ name: "phone.jpg", mimeType: "image/jpeg", buffer: await image("jpeg", 800, 1200, "#368") }]);
    await waitReady(page, 1);
    await expect(items(page)).toHaveCount(1);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await page.getByRole("link", { name: "List" }).click();
    await expect(page.getByTestId("media-list")).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);

    const open = items(page).first().getByRole("button", { name: "phone.jpg" });
    await open.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByTestId("media-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "phone.jpg" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});
