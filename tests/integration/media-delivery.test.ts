import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { completeUpload, requestUploads } from "@/modules/media";
import { createSite } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { platformStorage, type StorageDriver } from "@/platform/storage";
import { setStorageDriverForTests } from "@/platform/storage/get-driver";
import { DRIVERS, failing, html, imageOf, pdf, phonePhoto, removeTempDirs, send } from "../fixtures/media";
import { newSlug, newTenant } from "../fixtures/tenants";

// The route handler runs here outside Next: `connection()` (which only marks the response as per-request) is a no-op.
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {} }));
const { GET } = await import("@/app/media/[...key]/route");

/**
 * M6-2: `/media/{key}` through the real route handler, against real Postgres and both storage drivers. It serves
 * only what an authoritative record says is public now (a ready, untrashed image's variant, a ready document, a
 * user's current avatar: avatar-upload.test.ts), with the record's content type and the security headers, and one
 * answer, uncached, for everything else.
 */

afterAll(async () => {
  setStorageDriverForTests(null);
  await removeTempDirs();
});

type Tenant = Awaited<ReturnType<typeof newTenant>>;
async function siteOf(tenant: Tenant, name = "Delivery") {
  const { site } = await createSite(tenant.ctx, { name, address: newSlug("deliver"), language: "en", timezone: "UTC" });
  return { site, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}
const rowOf = async (ctx: SiteContext, id: string) =>
  (await inTenant(ctx, (tx) => tx.select().from(t.mediaAssets).where(and(eq(t.mediaAssets.organizationId, ctx.org.id), eq(t.mediaAssets.id, id)))))[0]!;
const get = (key: string) => GET(new Request(`http://localhost:3000/media/${key}`), { params: Promise.resolve({ key: key.split("/") }) });
/** A path as a client could send it, segments decoded by the router as Next decodes them. */
const getPath = (path: string) => GET(new Request(`http://localhost:3000/media/${path}`), { params: Promise.resolve({ key: path.split("/").map((s) => decodeURIComponent(s)) }) });
const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

async function uploaded(ctx: SiteContext, name: string, bytes: Uint8Array, type: string, options: { complete?: boolean } = { complete: true }) {
  const { uploads } = await requestUploads(ctx, [{ name, size: bytes.byteLength, type }]);
  expect(await send(uploads[0]!.upload, bytes)).toBe(200);
  if (options.complete) await completeUpload(ctx, uploads[0]!.mediaId);
  return rowOf(ctx, uploads[0]!.mediaId);
}

const NOT_FOUND = { status: 404, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
const statusOf = async (response: Response) => ({
  status: response.status,
  "cache-control": response.headers.get("cache-control"),
  "x-content-type-options": response.headers.get("x-content-type-options"),
  "content-security-policy": response.headers.get("content-security-policy"),
});

describe.each(DRIVERS)("/media/{key} with the %s driver", (_name, make) => {
  let driver: StorageDriver;
  beforeAll(async () => {
    driver = await make();
  });
  const working = () => setStorageDriverForTests(driver);

  it("a ready image's variants: streamed with the record's type, immutable caching, nosniff and the sandbox; never its original", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const row = await uploaded(ctx, "Beach day.jpg", await phonePhoto(1200, 900), "image/jpeg");
    expect(row.status).toBe("ready");
    expect(row.variants.map((v) => [v.key, v.format])).toEqual([["thumb", "webp"], ["w800", "webp"], ["logo", "webp"], ["fav32", "png"], ["fav180", "png"]]);
    for (const variant of row.variants) {
      const response = await get(variant.storageKey);
      expect(response.status, variant.key).toBe(200);
      expect(Object.fromEntries(response.headers)).toMatchObject({
        "content-type": `image/${variant.format}`, // the favicons are PNG (M6-4)
        "content-length": String(variant.sizeBytes),
        "cache-control": "public, max-age=31536000, immutable",
        "cdn-cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-disposition": `attachment; filename="beach-day.${variant.format}"`,
      });
      expect(response.headers.get("set-cookie")).toBeNull();
      const body = await bytesOf(response);
      expect(body).toEqual(new Uint8Array(await new Response((await platformStorage().get(variant.storageKey)).body).arrayBuffer()));
      expect((await sharp(body).metadata()).exif).toBeUndefined();
    }
    // The original still holds the photo's GPS position: it is not public, ready or not.
    expect(await statusOf(await get(row.storageKey))).toEqual(NOT_FOUND);
  });

  it("a ready PDF is served inline as a PDF; a document's file is its only object", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const row = await uploaded(ctx, "Menu.pdf", pdf(4_000), "application/pdf");
    const response = await get(row.storageKey);
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/pdf", "content-length": "4000", "content-disposition": `inline; filename="menu.pdf"`,
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
    });
    expect((await bytesOf(response)).subarray(0, 5)).toEqual(new TextEncoder().encode("%PDF-"));
  });

  it("not served: pending (sent, not checked), failed, trashed; the answer is never cached, so the URL works once it is ready", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const bytes = await imageOf("png", 900, 600);
    const pending = await uploaded(ctx, "wait.png", bytes, "image/png", { complete: false });
    const futureVariant = pending.storageKey.replace("/original/wait.png", "/w800/wait.webp");
    expect(await statusOf(await get(pending.storageKey))).toEqual(NOT_FOUND);
    expect(await statusOf(await get(futureVariant))).toEqual(NOT_FOUND);
    await completeUpload(ctx, pending.id);
    expect((await get(futureVariant)).status).toBe(200);

    // Sent as a PNG, is HTML: refused, and nothing of it is served (its object is deleted anyway).
    const refused = await uploaded(ctx, "page.png", html(2_000), "image/png");
    expect(refused.status).toBe("failed");
    expect(await statusOf(await get(refused.storageKey))).toEqual(NOT_FOUND);

    // A pending document whose file exists: not served until it is checked.
    const unchecked = await uploaded(ctx, "unchecked.pdf", pdf(3_000), "application/pdf", { complete: false });
    expect(await platformStorage().head(unchecked.storageKey)).not.toBeNull();
    expect(await statusOf(await get(unchecked.storageKey))).toEqual(NOT_FOUND);

    // Trashed: its objects still exist (until the purge, M7-1), and are not served.
    const trashed = await uploaded(ctx, "old.png", bytes, "image/png");
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ deletedAt: new Date() }).where(eq(t.mediaAssets.id, trashed.id)));
    for (const variant of trashed.variants) expect(await statusOf(await get(variant.storageKey))).toEqual(NOT_FOUND);
  });

  it("a key is only good for its own record: another media id, site or organization in it is not found", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { ctx: sibling } = await siteOf(a, "Sibling");
    const b = await newTenant("Other");
    const { ctx: elsewhere } = await siteOf(b);
    const row = await uploaded(ctx, "mine.png", await imageOf("png", 900, 600), "image/png");
    const theirs = await uploaded(elsewhere, "theirs.png", await imageOf("png", 900, 600), "image/png");
    const key = row.variants.find((v) => v.key === "w800")!.storageKey;
    expect((await get(key)).status).toBe(200);
    const swaps = [
      key.replace(`/s/${ctx.site.id}/`, `/s/${sibling.site.id}/`), // a sibling site of the same organization
      key.replace(`o/${ctx.org.id}/`, `o/${b.org.id}/`), // another organization, same media id
      key.replace(`o/${ctx.org.id}/s/${ctx.site.id}/`, `o/${b.org.id}/s/${elsewhere.site.id}/`),
      key.replace(`/m/${row.id}/`, `/m/${theirs.id}/`), // another organization's media id under this tenant's prefix
      key.replace(`/m/${row.id}/`, `/m/${uuidv7()}/`),
      key.replace("/v1/", "/v2/"),
      key.replace("/w800/", "/w1600/"), // a variant this image does not have (900 wide)
      key.replace("/mine.webp", "/other.webp"),
      key.replace(".webp", ".png"),
    ];
    for (const swapped of swaps) expect(await statusOf(await get(swapped)), swapped).toEqual(NOT_FOUND);
  });

  it("malformed and traversal keys, encoded or not, are not found, before storage is asked", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const row = await (async () => {
      working();
      return uploaded(ctx, "safe.png", await imageOf("png", 900, 600), "image/png");
    })();
    const key = row.variants[0]!.storageKey;
    // Storage refusing everything: a 404 below proves the key never reached it (a reached one would be 503).
    setStorageDriverForTests(failing(driver, ["get", "head", "readRange"]));
    for (const path of [
      "", "o", `${key}/`, `/${key}`, `${key}/..`, key.replace("/thumb/", "/../thumb/"), key.replace("/thumb/", "/%2e%2e/thumb/"),
      key.replace("/thumb/", "%2Fthumb%2F"), key.replace("/thumb/", "\\thumb\\"), key.replace("/thumb/", "/%5Cthumb/"), key.toUpperCase(),
      `${key}%00`, `${key}?x=1`, "../../etc/passwd", "%2e%2e/%2e%2e/etc/passwd", ".storage/.upload-secret", "u/../o/x", `u/${ctx.actor.userId}/a/x/thumb/avatar.webp`,
      `o/${ctx.org.id}/s/${ctx.site.id}/m/${row.id}/v1/thumb/safe.html`, `o/${ctx.org.id}/s/${ctx.site.id}/m/${row.id}/v1/thumb/safe.svg`,
    ]) {
      expect(await statusOf(await getPath(path)), path).toEqual(NOT_FOUND);
    }
    working();
  });

  it("storage trouble: a ready record whose object is gone is not found; storage down is unavailable; neither is cached", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const row = await uploaded(ctx, "gone.png", await imageOf("png", 900, 600), "image/png");
    const [thumb, w800] = row.variants;
    await platformStorage().delete(thumb!.storageKey);
    expect(await statusOf(await get(thumb!.storageKey))).toEqual(NOT_FOUND);
    setStorageDriverForTests(failing(driver, ["get"]));
    const down = await get(w800!.storageKey);
    expect(await statusOf(down)).toEqual({ ...NOT_FOUND, status: 503 });
    expect(await down.text()).toBe("Temporarily unavailable"); // nothing about the key, the store or the error
    working();
  });
});
