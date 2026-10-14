import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { asUniqueVisitor, newEmail, signUp } from "./helpers/auth";

/**
 * M6-2 end to end against the production build, with the local storage driver (no account): the account picture
 * goes from the browser straight to the storage target, is checked and made square on the server, and is served
 * from /media with the media headers, the same for everyone (no cookie in, none out). Real image processing is
 * covered with both drivers in tests/integration/media-processing.test.ts.
 */

test.skip(!!process.env.E2E_BASE_URL, "uploads here go to the local storage driver's route");

const section = (page: Page, name: string) => page.getByRole("region", { name });
const picture = async (format: "png" | "jpeg", width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } })[format]().toBuffer();
const MEDIA_HEADERS = {
  "content-type": "image/webp",
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("a picture on /account: sent to storage, made square, shown in the header, served from /media; a new one replaces it", async ({ page }) => {
  await signUp(page, newEmail(), { name: "Pia Picture" });
  await page.goto("/account");
  const area = section(page, "Picture");
  await expect(area.getByTestId("avatar-initials")).toHaveText("PP");

  await area.getByLabel("Upload a picture").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: await picture("png", 900, 600, "#2a6") });
  await expect(area.locator('[data-form-alert][role="status"]')).toHaveText("Picture updated.");
  const preview = area.getByTestId("avatar-preview");
  await expect(preview).toHaveAttribute("src", /\/media\/u\/[0-9a-f-]{36}\/a\/[0-9a-f-]{36}\/thumb\/avatar\.webp$/);
  // Loaded in the browser: the 400-pixel square the server made from a 900 × 600 picture.
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => (img.complete ? [img.naturalWidth, img.naturalHeight] : null))).toEqual([400, 400]);
  const first = (await preview.getAttribute("src"))!;
  await expect(page.getByTestId("account-avatar")).toHaveAttribute("src", first);

  // Asked for with the session cookie: the proxy strips it, and nothing sets one on a public, cached object.
  const served = await page.request.get(first);
  expect(served.status()).toBe(200);
  expect(served.headers()).toMatchObject(MEDIA_HEADERS);
  expect(served.headers()["set-cookie"]).toBeUndefined();
  expect(served.headers()["content-disposition"]).toBe('attachment; filename="avatar.webp"');

  await area.getByLabel("Change picture").setInputFiles({ name: "new.jpg", mimeType: "image/jpeg", buffer: await picture("jpeg", 300, 500, "#a26") });
  await expect(preview).not.toHaveAttribute("src", first);
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => (img.complete ? [img.naturalWidth, img.naturalHeight] : null))).toEqual([300, 300]);
  expect((await page.request.get(first)).status()).toBe(404); // replaced: no longer anyone's picture
});

test("a file that is not what it says is refused with the reason, and the picture does not change", async ({ page }) => {
  await signUp(page, newEmail(), { name: "Rex Refused" });
  await page.goto("/account");
  const area = section(page, "Picture");
  const html = Buffer.from(`<!doctype html><script>alert(document.cookie)</script>${" ".repeat(500)}`);
  await area.getByLabel("Upload a picture").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: html });
  await expect(area.locator('[data-form-alert][role="alert"]')).toContainText("is not a PNG file");
  await expect(area.getByTestId("avatar-initials")).toHaveText("RR");
  await expect(page.getByTestId("account-avatar")).toHaveCount(0);
});

test("/media answers anything that is not a public object with a 404 that is never cached and carries the media headers", async ({ request }) => {
  const id = () => crypto.randomUUID();
  for (const path of [`o/${id()}/s/${id()}/m/${id()}/v1/w800/photo.webp`, `u/${id()}/a/${id()}/thumb/avatar.webp`, `o/${id()}/s/${id()}/m/${id()}/v1/original/photo.jpg`, "x"]) {
    const response = await request.get(`/media/${path}`);
    expect(response.status(), path).toBe(404);
    expect(response.headers()["cache-control"], path).toBe("no-store");
    expect(response.headers()["x-content-type-options"], path).toBe("nosniff");
    expect(response.headers()["content-security-policy"], path).toBe("default-src 'none'; sandbox");
    expect(response.headers()["set-cookie"], path).toBeUndefined();
  }
});
