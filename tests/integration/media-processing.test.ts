import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowanceOf } from "@/modules/billing";
import { cleanUpUploads, completeUpload, processImage, requestUploads, type IssuedUpload } from "@/modules/media";
import { createSite } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { platformStorage, type StorageDriver } from "@/platform/storage";
import { setStorageDriverForTests } from "@/platform/storage/get-driver";
import { whileFailing } from "../fixtures/db-failure";
import { animatedGif, DRIVERS, failing, fileOf, hasGps, imageOf, localDriver, pdf, phonePhoto, removeTempDirs, send } from "../fixtures/media";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

/**
 * M6-2 against real Postgres and both storage drivers (a temp directory; RustFS over the S3 API): an image completed
 * through the upload protocol is decoded, auto-rotated, stripped of every piece of metadata and stored as WebP
 * variants; their real bytes count towards the storage limit; it becomes `ready` only when every variant is stored;
 * any failure deletes what it wrote, or leaves it named on the row for the next completion or the cleanup.
 */

const GB = 1024 ** 3;
afterAll(async () => {
  setStorageDriverForTests(null);
  await removeTempDirs();
});

type Tenant = Awaited<ReturnType<typeof newTenant>>;
async function siteOf(tenant: Tenant, name = "Processing") {
  const { site } = await createSite(tenant.ctx, { name, address: newSlug("proc"), language: "en", timezone: "UTC" });
  return { site, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}
const rowOf = async (ctx: SiteContext, id: string) =>
  (await inTenant(ctx, (tx) => tx.select().from(t.mediaAssets).where(and(eq(t.mediaAssets.organizationId, ctx.org.id), eq(t.mediaAssets.id, id)))))[0] ?? null;
const eventsOf = (ctx: SiteContext, id: string) =>
  inTenant(ctx, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.resourceId, id))));
const setPlan = (orgId: string, planKey: "free" | "pro") =>
  withTenant({ orgId }, (tx) => tx.update(t.subscriptions).set({ planKey, status: planKey === "free" ? "free" : "trialing" }).where(eq(t.subscriptions.organizationId, orgId)));
const fill = (ctx: SiteContext, sizeBytes: number) =>
  withTenant({ orgId: ctx.org.id }, (tx) =>
    tx.insert(t.mediaAssets).values({
      organizationId: ctx.org.id, siteId: ctx.site.id, kind: "document", status: "ready", storageKey: `o/${ctx.org.id}/s/${ctx.site.id}/m/${uuidv7()}/v1/original/filler.pdf`,
      originalFilename: "filler.pdf", mimeType: "application/pdf", sizeBytes, uploadedBy: ctx.actor.userId,
    }),
  );
const storageUsed = async (ctx: SiteContext) => (await withTenant({ orgId: ctx.org.id }, (tx) => allowanceOf(tx, ctx.org.id, "storage"))).used;
const readAll = async (key: string) => new Uint8Array(await new Response((await platformStorage().get(key)).body).arrayBuffer());

/** Request and send one file; complete it later. */
async function sent(ctx: SiteContext, name: string, bytes: Uint8Array, type: string): Promise<IssuedUpload> {
  const { uploads } = await requestUploads(ctx, [{ name, size: bytes.byteLength, type }]);
  expect(await send(uploads[0]!.upload, bytes)).toBe(200);
  return uploads[0]!;
}

describe.each(DRIVERS)("processing images with the %s driver", (_name, make) => {
  let driver: StorageDriver;
  beforeAll(async () => {
    driver = await make();
  });
  const working = () => setStorageDriverForTests(driver);

  it("a phone photo: auto-rotated, every piece of metadata (GPS too) gone from each WebP variant, its ladder up to its width, counted", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const photo = await phonePhoto(3000, 2000); // stored landscape, shown portrait (orientation 6)
    const source = await sharp(photo).metadata();
    expect(source.orientation).toBe(6);
    expect(hasGps(source.exif)).toBe(true);

    const issued = await sent(ctx, "Holiday.jpg", photo, "image/jpeg");
    const outcome = await completeUpload(ctx, issued.mediaId);
    expect(outcome).toMatchObject({ status: "ready", media: { width: 2000, height: 3000 } });
    const row = (await rowOf(ctx, issued.mediaId))!;
    expect(row).toMatchObject({ status: "ready", width: 2000, height: 3000, processingToken: null, processingUntil: null });
    // 2000 wide once turned: the thumbnail, 800 and 1600, never 2400 (above the original); then what a site's logo and
    // favicon use (M6-4): the logo inside 640 × 240, favicons of 32 and 180 as PNG.
    expect(row.variants.map((v) => [v.key, v.format, v.width, v.height])).toEqual([
      ["thumb", "webp", 400, 400], ["w800", "webp", 800, 1200], ["w1600", "webp", 1600, 2400],
      ["logo", "webp", 160, 240], ["fav32", "png", 32, 32], ["fav180", "png", 180, 180],
    ]);
    for (const variant of row.variants) {
      expect(variant.storageKey).toBe(row.storageKey.replace("/original/holiday.jpg", `/${variant.key}/holiday.${variant.format}`));
      const bytes = await readAll(variant.storageKey);
      expect(bytes.byteLength).toBe(variant.sizeBytes);
      const meta = await sharp(bytes).metadata();
      expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({ format: variant.format, width: variant.width, height: variant.height });
      expect({ exif: meta.exif, xmp: meta.xmp, icc: meta.icc, iptc: meta.iptc, orientation: meta.orientation }, variant.key).toEqual({
        exif: undefined, xmp: undefined, icc: undefined, iptc: undefined, orientation: undefined,
      });
      expect(await platformStorage().head(variant.storageKey)).toEqual({ size: variant.sizeBytes, contentType: `image/${variant.format}` });
    }
    // The original is kept as uploaded (GPS and all): it is never served (media-delivery.test.ts).
    expect(hasGps((await sharp(await readAll(row.storageKey)).metadata()).exif)).toBe(true);
    const variantBytes = row.variants.reduce((sum, v) => sum + v.sizeBytes, 0);
    expect(row.variantBytes).toBe(variantBytes);
    expect(outcome).toMatchObject({ media: { storedBytes: photo.byteLength + variantBytes } });
    expect(await storageUsed(ctx)).toBe(photo.byteLength + variantBytes);
    expect(await eventsOf(ctx, issued.mediaId)).toHaveLength(1);
  });

  it("every allowed image type; a small one gets its own width and a smaller square; an animation stays animated in every variant", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const cases = [
      ["wide.png", await imageOf("png", 2600, 1300), "image/png", [["thumb", 400, 400], ["w800", 800, 400], ["w1600", 1600, 800], ["w2400", 2400, 1200], ["logo", 480, 240]]],
      ["small.webp", await imageOf("webp", 300, 200), "image/webp", [["thumb", 200, 200], ["w300", 300, 200], ["logo", 300, 200]]], // a logo is never enlarged
      ["still.gif", await imageOf("gif", 900, 600), "image/gif", [["thumb", 400, 400], ["w800", 800, 533], ["logo", 360, 240]]],
      ["exact.jpg", await imageOf("jpeg", 800, 800), "image/jpeg", [["thumb", 400, 400], ["w800", 800, 800], ["logo", 240, 240]]],
    ] as const;
    for (const [name, bytes, type, expected] of cases) {
      const issued = await sent(ctx, name, bytes, type);
      expect((await completeUpload(ctx, issued.mediaId)).status, name).toBe("ready");
      // Favicons are always 32 and 180: a browser asks for those sizes, whatever the image.
      expect((await rowOf(ctx, issued.mediaId))!.variants.map((v) => [v.key, v.width, v.height]), name).toEqual([...expected, ["fav32", 32, 32], ["fav180", 180, 180]]);
    }

    const issued = await sent(ctx, "loop.gif", await animatedGif(3, 1000, 500), "image/gif");
    expect(await completeUpload(ctx, issued.mediaId)).toMatchObject({ status: "ready", media: { width: 1000, height: 500 } });
    // The thumbnail and the widths stay animated; a logo and favicons are the first frame.
    for (const variant of (await rowOf(ctx, issued.mediaId))!.variants) {
      const meta = await sharp(await readAll(variant.storageKey), { animated: true }).metadata();
      const still = ["logo", "fav32", "fav180"].includes(variant.key);
      expect({ key: variant.key, pages: meta.pages ?? 1, frameHeight: still ? meta.height : meta.pageHeight }).toEqual({ key: variant.key, pages: still ? 1 : 3, frameHeight: variant.height });
    }
  });

  it("a PDF is not an image: no processing, no variants, nothing more counted", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const issued = await sent(ctx, "menu.pdf", pdf(7_000), "application/pdf");
    expect(await completeUpload(ctx, issued.mediaId)).toMatchObject({ status: "ready", media: { kind: "document", width: null, height: null, storedBytes: 7_000 } });
    expect((await rowOf(ctx, issued.mediaId))!).toMatchObject({ variants: [], variantBytes: 0, width: null, height: null });
  });

  it("refused as the file's fault: undecodable, truncated, a fake, too many pixels, too many frames; failed, every object gone, nothing recorded", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const good = await imageOf("jpeg", 640, 480);
    const huge = new Uint8Array(await sharp({ create: { width: 8000, height: 7600, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer());
    const cases: [string, Uint8Array, string, RegExp][] = [
      ["fake.png", fileOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 3_000), "image/png", /could not be (read|processed) as an image/],
      ["cut.jpg", good.subarray(0, Math.floor(good.byteLength / 2)), "image/jpeg", /could not be (read|processed) as an image/],
      ["noise.gif", fileOf("GIF89a", 2_000, 0xff), "image/gif", /could not be (read|processed) as an image/],
      ["huge.png", huge, "image/png", /^huge\.png is 60\.8 megapixels; images can be at most 50\.$/],
      ["flipbook.gif", await animatedGif(5, 4000, 3000), "image/gif", /has too many frames at this size \(60 megapixels in all; at most 50\)/],
    ];
    for (const [name, bytes, type, message] of cases) {
      const started = Date.now();
      const issued = await sent(ctx, name, bytes, type);
      const outcome = await completeUpload(ctx, issued.mediaId);
      expect(outcome, name).toMatchObject({ status: "failed", message: expect.stringMatching(message) });
      const row = (await rowOf(ctx, issued.mediaId))!;
      expect(row.status, name).toBe("failed");
      for (const key of [row.storageKey, ...row.variants.map((v) => v.storageKey)]) expect(await platformStorage().head(key), `${name} ${key}`).toBeNull();
      expect(await eventsOf(ctx, issued.mediaId), name).toHaveLength(0);
      if (name === "huge.png") expect(Date.now() - started).toBeLessThan(5_000); // refused from its header, never decoded
    }
    expect(await storageUsed(ctx)).toBe(0); // failed uploads give everything back
  });

  it("a variant that cannot be stored: still pending, nothing of it left, the hold let go; completing again works", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    working();
    const issued = await sent(ctx, "photo.png", await imageOf("png", 1700, 900), "image/png");
    setStorageDriverForTests(failing(driver, ["put"]));
    expect(await refusalOf(() => completeUpload(ctx, issued.mediaId))).toMatchObject({ kind: "Unavailable" });
    const row = (await rowOf(ctx, issued.mediaId))!;
    expect(row).toMatchObject({ status: "pending", processingToken: null, processingUntil: null, variants: [], variantBytes: 0 });
    working();
    expect((await completeUpload(ctx, issued.mediaId)).status).toBe("ready");
    const done = (await rowOf(ctx, issued.mediaId))!;
    for (const variant of done.variants) expect(await platformStorage().head(variant.storageKey)).not.toBeNull();
  });

  it("one variant fails to store while the others are stored (and one is slow): none is left behind, still pending", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    working();
    const issued = await sent(ctx, "partly.png", await imageOf("png", 1700, 900), "image/png");
    // w800 is refused; thumb is slow, so it lands after the refusal: the clean-up must wait for it.
    setStorageDriverForTests({
      ...failing(driver, []),
      put: async (key, body, options) => {
        if (key.includes("/w800/")) throw new (await import("@/platform/storage")).StorageError("Unavailable", "test");
        if (key.includes("/thumb/")) await new Promise((resolve) => setTimeout(resolve, 300));
        return driver.put(key, body, options);
      },
    });
    expect(await refusalOf(() => completeUpload(ctx, issued.mediaId))).toMatchObject({ kind: "Unavailable" });
    await new Promise((resolve) => setTimeout(resolve, 600)); // past the slow write, had it still been in flight
    working();
    const row = (await rowOf(ctx, issued.mediaId))!;
    expect(row).toMatchObject({ status: "pending", processingToken: null, variants: [] });
    for (const key of ["thumb", "w800", "w1600"]) expect(await platformStorage().head(row.storageKey.replace("/original/partly.png", `/${key}/partly.webp`)), key).toBeNull();
  });

  it("the final transaction fails (the audit write): the variants are deleted, still pending; completing again makes them anew", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const issued = await sent(ctx, "photo.webp", await imageOf("webp", 1000, 700), "image/webp");
    await whileFailing("audit_logs", "insert", () => expect(completeUpload(ctx, issued.mediaId)).rejects.toThrow());
    const row = (await rowOf(ctx, issued.mediaId))!;
    expect(row).toMatchObject({ status: "pending", processingToken: null, variants: [], variantBytes: 0 });
    for (const key of ["thumb", "w800"]) expect(await platformStorage().head(row.storageKey.replace("/original/photo.webp", `/${key}/photo.webp`))).toBeNull();
    expect(await platformStorage().head(row.storageKey)).not.toBeNull(); // the original stays: it was fine
    expect((await completeUpload(ctx, issued.mediaId)).status).toBe("ready");
    expect(await eventsOf(ctx, issued.mediaId)).toHaveLength(1);
  });

  it("a completion that died half-way (its hold ran out): the next one deletes what it left and finishes; while it held, others waited", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const bytes = await imageOf("png", 1000, 600);
    const issued = await sent(ctx, "half.png", bytes, "image/png");
    const original = (await rowOf(ctx, issued.mediaId))!;
    // What a dead completion leaves: its hold, the variants it named, one of them written, some bytes that are not it.
    const leftover = { key: "w800", format: "webp" as const, width: 800, height: 480, sizeBytes: 0, storageKey: original.storageKey.replace("/original/half.png", "/w800/half.webp") };
    await platformStorage().put(leftover.storageKey, new Uint8Array([1, 2, 3]), { contentType: "image/webp" });
    await withTenant({ orgId: a.org.id }, (tx) =>
      tx.update(t.mediaAssets).set({ processingToken: uuidv7(), processingUntil: sql`now() + interval '10 minutes'`, variants: [leftover] }).where(eq(t.mediaAssets.id, issued.mediaId)),
    );
    // Held (and not run out): a second completion waits for it, then says to try again; the cleanup leaves it alone.
    expect(await refusalOf(() => completeUpload(ctx, issued.mediaId, { waitMs: 300 }))).toMatchObject({ kind: "Conflict", message: "This upload is still being finished. Try again in a moment." });
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ createdAt: sql`now() - interval '25 hours'` }).where(eq(t.mediaAssets.id, issued.mediaId)));
    await cleanUpUploads();
    expect((await rowOf(ctx, issued.mediaId))!.status).toBe("pending");
    // Run out: taken over.
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ processingUntil: sql`now() - interval '1 second'`, createdAt: sql`now()` }).where(eq(t.mediaAssets.id, issued.mediaId)));
    expect((await completeUpload(ctx, issued.mediaId)).status).toBe("ready");
    const done = (await rowOf(ctx, issued.mediaId))!;
    const w800 = done.variants.find((v) => v.key === "w800")!;
    expect((await sharp(await readAll(w800.storageKey)).metadata()).width).toBe(800); // made anew, not the leftover bytes
  });

  it("three completions at once of one image: one processes, the others wait and answer ready; one record", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const issued = await sent(ctx, "busy.jpg", await imageOf("jpeg", 1800, 1200), "image/jpeg");
    const outcomes = await Promise.all([1, 2, 3].map(() => completeUpload(ctx, issued.mediaId)));
    expect(outcomes.map((o) => o.status)).toEqual(["ready", "ready", "ready"]);
    expect(await eventsOf(ctx, issued.mediaId)).toHaveLength(1);
    const row = (await rowOf(ctx, issued.mediaId))!;
    expect(row.variants.map((v) => v.key)).toEqual(["thumb", "w800", "w1600", "logo", "fav32", "fav180"]);
  });
});

describe("the storage limit counts variants (with the local driver)", () => {
  beforeAll(async () => setStorageDriverForTests(await localDriver()));
  const image = () => imageOf("png", 1700, 1000, { r: 10, g: 200, b: 140 });

  it("the original is counted once (reserved when requested); its variants when ready; refused past the limit, everything given back", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    await setPlan(a.org.id, "free");
    const bytes = await image();
    const variantBytes = (await processImage(bytes, "image/png")).variants.reduce((sum, v) => sum + v.data.byteLength, 0);
    expect(variantBytes).toBeGreaterThan(0);

    // Room for the original, not for its variants: requested fine, refused when complete.
    await fill(ctx, GB - bytes.byteLength - variantBytes + 1);
    const issued = await sent(ctx, "big.png", bytes, "image/png");
    expect(await storageUsed(ctx)).toBe(GB - variantBytes + 1); // the reservation: the original, once
    const outcome = await completeUpload(ctx, issued.mediaId);
    expect(outcome).toMatchObject({ status: "failed", code: "LimitExceeded", message: expect.stringContaining("The Free plan includes 1 GiB of storage") });
    const row = (await rowOf(ctx, issued.mediaId))!;
    expect(row.status).toBe("failed");
    for (const key of [row.storageKey, ...row.variants.map((v) => v.storageKey)]) expect(await platformStorage().head(key)).toBeNull();
    expect(await storageUsed(ctx)).toBe(GB - bytes.byteLength - variantBytes + 1);

    // Exactly enough: ready, and counted exactly once each.
    const b = await newTenant();
    const { ctx: other } = await siteOf(b);
    await setPlan(b.org.id, "free");
    await fill(other, GB - bytes.byteLength - variantBytes);
    const fits = await sent(other, "fits.png", bytes, "image/png");
    expect((await completeUpload(other, fits.mediaId)).status).toBe("ready");
    expect(await storageUsed(other)).toBe(GB);
  });

  it("concurrent completions near the limit: the organization's lock lets exactly one take the last room, in every round", async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newTenant();
      const { site, ctx } = await siteOf(a);
      await setPlan(a.org.id, "free");
      const editor = await resolveSiteContext((await addMember(a.org, "editor")).actor, a.org.slug, site.slug);
      const bytes = await image();
      const variantBytes = (await processImage(bytes, "image/png")).variants.reduce((sum, v) => sum + v.data.byteLength, 0);
      const first = await sent(ctx, "one.png", bytes, "image/png");
      const second = await sent(editor, "two.png", bytes, "image/png");
      // Both originals are reserved already; room for one set of variants and a little more, not two.
      await fill(ctx, GB - 2 * bytes.byteLength - variantBytes - Math.floor(variantBytes / 2));
      const outcomes = await Promise.all([completeUpload(ctx, first.mediaId), completeUpload(editor, second.mediaId)]);
      expect(outcomes.map((o) => o.status).sort(), `round ${round}`).toEqual(["failed", "ready"]);
      expect(outcomes.find((o) => o.status === "failed")).toMatchObject({ code: "LimitExceeded" });
      expect(await storageUsed(ctx)).toBeLessThanOrEqual(GB);
      expect(await storageUsed(ctx)).toBe(GB - bytes.byteLength - Math.floor(variantBytes / 2));
    }
  });

  it("the cleanup deletes every variant a dead completion named, with the original, then the row", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const bytes = await image();
    const issued = await sent(ctx, "dead.png", bytes, "image/png");
    const row = (await rowOf(ctx, issued.mediaId))!;
    const leftovers = ["thumb", "w800", "w1600"].map((key) => ({ key, format: "webp" as const, width: 1, height: 1, sizeBytes: 0, storageKey: row.storageKey.replace("/original/dead.png", `/${key}/dead.webp`) }));
    for (const v of leftovers) await platformStorage().put(v.storageKey, new Uint8Array([7]), { contentType: "image/webp" });
    await withTenant({ orgId: a.org.id }, (tx) =>
      tx.update(t.mediaAssets).set({ variants: leftovers, processingToken: uuidv7(), processingUntil: sql`now() - interval '1 minute'`, createdAt: sql`now() - interval '25 hours'` }).where(eq(t.mediaAssets.id, issued.mediaId)),
    );
    const result = await cleanUpUploads();
    expect(result.kept).toBe(0);
    expect(await rowOf(ctx, issued.mediaId)).toBeNull();
    for (const key of [row.storageKey, ...leftovers.map((v) => v.storageKey)]) expect(await platformStorage().head(key)).toBeNull();
  });
});
