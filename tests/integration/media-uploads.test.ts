import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DAILY_JOBS, jobRegistry } from "@/app/api/internal/cron/jobs";
import { createEntry, saveDraft } from "@/modules/content";
import {
  cleanUpUploads, completeUpload, requestUploads, submitCompleteUpload, submitRequestUploads, uploadsCleanup, type IssuedUpload,
} from "@/modules/media";
import { createSite } from "@/modules/sites";
import { inTenant, resolveSiteContext, type SiteContext } from "@/modules/tenancy";
import * as t from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import { logger } from "@/platform/observability";
import { handleLocalUpload, platformStorage, StorageError, type StorageDriver } from "@/platform/storage";
import { setStorageDriverForTests } from "@/platform/storage/get-driver";
import { LocalStorageDriver } from "@/platform/storage/providers/local";
import { S3StorageDriver } from "@/platform/storage/providers/s3";
import { whileFailing } from "../fixtures/db-failure";
import { addMember, newSlug, newTenant, refusalOf } from "../fixtures/tenants";

// Uploads change no public page (a new file is in no content yet): nothing may be flushed or revalidated.
const cacheCalls = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("next/cache", async (original) => ({
  ...(await original<typeof import("next/cache")>()),
  updateTag: (tag: string) => void cacheCalls.calls.push(`updateTag ${tag}`),
  revalidateTag: (tag: string) => void cacheCalls.calls.push(`revalidateTag ${tag}`),
  revalidatePath: (p: string) => void cacheCalls.calls.push(`revalidatePath ${p}`),
}));

/**
 * M6-1 against real Postgres and both storage drivers: the local filesystem driver (a temp directory) and the S3
 * driver against the RustFS container (the S3 API, as Cloudflare R2; real R2 is not exercised here). A browser's
 * part is played by `send()`: a PUT to the issued target, exactly as a browser would make it.
 *
 *   requestUploads   type, size and storage-limit checks; pending rows; targets that take exactly the declared file, once
 *   completeUpload   what storage holds is checked (size, type, magic bytes): ready, or deleted and failed
 *   uploads.cleanup  never-completed and refused uploads removed with their objects, after 24 hours
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;
const APP = "http://localhost:3000";

const s3Config = {
  driver: "s3" as const,
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.TEST_S3_REGION ?? "auto",
  bucket: process.env.TEST_S3_BUCKET ?? `forge-test-w${process.env.VITEST_POOL_ID ?? "1"}`,
  accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "forge",
  secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "forge-secret-key",
  forcePathStyle: true,
};
const tempDirs: string[] = [];
const publicBaseUrl = () => `${APP}/media`;
async function localDriver() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-media-"));
  tempDirs.push(dir);
  return new LocalStorageDriver({ root: dir, appOrigin: () => APP, publicBaseUrl });
}
async function s3Driver() {
  if (!process.env.TEST_S3_BUCKET) {
    const client = new S3Client({ endpoint: s3Config.endpoint, region: "auto", forcePathStyle: true, credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey } });
    await client.send(new CreateBucketCommand({ Bucket: s3Config.bucket })).catch((e: { name?: string }) => {
      if (!/BucketAlready/.test(e.name ?? "")) throw e;
    });
  }
  return new S3StorageDriver({ ...s3Config, publicBaseUrl });
}
afterAll(async () => {
  setStorageDriverForTests(null);
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ── Files ─────────────────────────────────────────────────────────────────────

/** Bytes that start with a signature and are nothing after it: a document, or a fake that no decoder accepts. */
const fileOf = (signature: number[] | string, size: number, fill = 0x20) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(typeof signature === "string" ? [...signature].map((c) => c.charCodeAt(0)) : signature);
  return bytes;
};
const pdf = (size = 2_048) => fileOf("%PDF-1.7\n", size);
const html = (size = 2_048) => fileOf("<!doctype html><script>alert(document.cookie)</script>", size);
/** Real images (M6-2: an image is decoded and processed when completed), made once. */
const imageOf = async (format: "png" | "jpeg" | "webp" | "gif", width = 96, height = 64) =>
  new Uint8Array(await sharp({ create: { width, height, channels: 3, background: { r: 40, g: 120, b: 90 } } })[format]().toBuffer());
const IMAGES = { png: await imageOf("png"), jpeg: await imageOf("jpeg"), webp: await imageOf("webp"), gif: await imageOf("gif") };
const png = () => IMAGES.png;
const jpeg = () => IMAGES.jpeg;
const gif = () => IMAGES.gif;
const webp = () => IMAGES.webp;
const describeFile = (name: string, bytes: Uint8Array, type: string) => ({ name, size: bytes.byteLength, type });

// ── Tenants, sites, rows ──────────────────────────────────────────────────────

type Tenant = Awaited<ReturnType<typeof newTenant>>;
async function siteOf(tenant: Tenant, name = "Media") {
  const { site } = await createSite(tenant.ctx, { name, address: newSlug("media"), language: "en", timezone: "UTC" });
  return { site, ctx: await resolveSiteContext(tenant.actor, tenant.org.slug, site.slug) };
}
const asMember = (member: { actor: Tenant["actor"] }, tenant: Tenant, site: { slug: string }) => resolveSiteContext(member.actor, tenant.org.slug, site.slug);
const rowOf = async (ctx: SiteContext, id: string) =>
  (await inTenant(ctx, (tx) => tx.select().from(t.mediaAssets).where(and(eq(t.mediaAssets.organizationId, ctx.org.id), eq(t.mediaAssets.id, id)))))[0] ?? null;
const rowsOfSite = (ctx: SiteContext) => inTenant(ctx, (tx) => tx.select().from(t.mediaAssets).where(eq(t.mediaAssets.siteId, ctx.site.id)));
const uploadEvents = async (ctx: SiteContext) =>
  inTenant(ctx, (tx) => tx.select().from(t.auditLogs).where(and(eq(t.auditLogs.organizationId, ctx.org.id), eq(t.auditLogs.action, "media.uploaded"))));
const setPlan = (orgId: string, planKey: "free" | "pro") =>
  withTenant({ orgId }, (tx) => tx.update(t.subscriptions).set({ planKey, status: planKey === "free" ? "free" : "trialing" }).where(eq(t.subscriptions.organizationId, orgId)));
/** Storage used by something else: a ready item of this size, as the library would hold it. */
const fill = (ctx: SiteContext, sizeBytes: number, status: "ready" | "failed" | "pending" = "ready", deleted = false) =>
  withTenant({ orgId: ctx.org.id }, (tx) =>
    tx.insert(t.mediaAssets).values({
      organizationId: ctx.org.id, siteId: ctx.site.id, kind: "document", status, storageKey: `o/${ctx.org.id}/s/${ctx.site.id}/m/${uuidv7()}/v1/original/filler.pdf`,
      originalFilename: "filler.pdf", mimeType: "application/pdf", sizeBytes, uploadedBy: ctx.actor.userId, deletedAt: deleted ? new Date() : null,
    }),
  );
/** Makes this upload as old as the cleanup's cutoff and more. */
const age = (ctx: SiteContext, id: string, hours = 25) =>
  withTenant({ orgId: ctx.org.id }, (tx) => tx.update(t.mediaAssets).set({ createdAt: sql`now() - make_interval(hours => ${hours})` }).where(eq(t.mediaAssets.id, id)));

/** The browser's part: PUT the bytes to the target with its headers (or others). */
async function send(target: IssuedUpload["upload"], body: Uint8Array, headers: Record<string, string> = target.headers): Promise<number> {
  if (target.url.startsWith(`${APP}/api/storage/local/`)) {
    const request = new Request(target.url, { method: "PUT", headers, body: body as BodyInit });
    return (await handleLocalUpload(request, new URL(target.url).pathname.replace(/^\/api\/storage\/local\//, ""))).status;
  }
  return (await fetch(target.url, { method: "PUT", headers, body: body as BodyInit })).status;
}
/** Request, send and complete one file: the whole protocol. */
async function upload(ctx: SiteContext, name: string, bytes: Uint8Array, type: string) {
  const { uploads } = await requestUploads(ctx, [describeFile(name, bytes, type)]);
  expect(await send(uploads[0]!.upload, bytes)).toBe(200);
  return { issued: uploads[0]!, outcome: await completeUpload(ctx, uploads[0]!.mediaId) };
}

/** The real driver, with some operations failing as an unreachable store would. */
function failing(base: StorageDriver, ops: ("head" | "readRange" | "delete" | "createUpload")[]): StorageDriver {
  const down = async (): Promise<never> => {
    throw new StorageError("Unavailable", "Storage is unavailable (test)");
  };
  return {
    name: base.name,
    put: (key, body, options) => base.put(key, body, options),
    get: (key) => base.get(key),
    head: ops.includes("head") ? down : (key) => base.head(key),
    readRange: ops.includes("readRange") ? down : (key, start, end) => base.readRange(key, start, end),
    delete: ops.includes("delete") ? down : (key) => base.delete(key),
    createUpload: ops.includes("createUpload") ? down : (input) => base.createUpload(input),
    publicUrl: (key) => base.publicUrl(key),
  };
}

describe.each([
  ["local filesystem", localDriver],
  ["s3-compatible (RustFS)", s3Driver],
] as const)("the upload protocol with the %s driver", (_name, make) => {
  let driver: StorageDriver;
  beforeAll(async () => {
    driver = await make();
    setStorageDriverForTests(driver);
  });
  // Each test sets what it breaks; the next starts from the working driver.
  const working = () => setStorageDriverForTests(driver);

  it("happy path: pending rows and targets; the files PUT; each completed is ready and recorded once", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const files = { photo: png(), menu: pdf(9_000), still: jpeg(), loop: gif(), modern: webp() };
    const before = Date.now();
    const { uploads } = await requestUploads(ctx, [
      describeFile("Team photo.PNG", files.photo, "image/png"),
      describeFile("Menu (autumn).pdf", files.menu, "application/pdf"),
      describeFile("still.jpg", files.still, "image/jpeg"),
      describeFile("loop.gif", files.loop, "image/gif"),
      describeFile("modern.webp", files.modern, "image/webp"),
    ]);

    expect(uploads.map((u) => [u.name, u.kind])).toEqual([
      ["Team photo.PNG", "image"], ["Menu (autumn).pdf", "document"], ["still.jpg", "image"], ["loop.gif", "image"], ["modern.webp", "image"],
    ]);
    for (const u of uploads) {
      expect(u.upload.method).toBe("PUT");
      expect(u.upload.headers["if-none-match"]).toBe("*");
      const expires = new Date(u.upload.expiresAt).getTime();
      expect(expires).toBeGreaterThanOrEqual(before + 600_000 - 2_000);
      expect(expires).toBeLessThanOrEqual(Date.now() + 600_000 + 2_000);
    }
    const rows = await rowsOfSite(ctx);
    expect(rows).toHaveLength(5);
    const photo = rows.find((row) => row.id === uploads[0]!.mediaId)!;
    expect(photo).toMatchObject({
      organizationId: ctx.org.id, siteId: ctx.site.id, kind: "image", status: "pending", storageDriver: driver.name, version: 1,
      originalFilename: "Team photo.PNG", mimeType: "image/png", sizeBytes: files.photo.byteLength, uploadedBy: a.user.id, deletedAt: null,
      storageKey: `o/${ctx.org.id}/s/${ctx.site.id}/m/${photo.id}/v1/original/team-photo.png`,
    });
    expect(rows.find((row) => row.id === uploads[1]!.mediaId)!.storageKey).toMatch(/\/m\/[0-9a-f-]{36}\/v1\/original\/menu-autumn\.pdf$/);
    // Nothing exists in storage until the browser sends it: a target is not an upload.
    expect(await platformStorage().head(photo.storageKey)).toBeNull();

    const bytes = Object.values(files);
    for (const [i, u] of uploads.entries()) expect(await send(u.upload, bytes[i]!)).toBe(200);
    const outcomes = await Promise.all(uploads.map((u) => completeUpload(ctx, u.mediaId)));
    expect(outcomes.map((o) => o.status)).toEqual(["ready", "ready", "ready", "ready", "ready"]);
    const variantBytes = (await rowOf(ctx, photo.id))!.variantBytes;
    expect(variantBytes).toBeGreaterThan(0); // M6-2: its variants (their own tests: media-processing.test.ts)
    expect(outcomes[0]).toEqual({
      status: "ready",
      media: { id: photo.id, kind: "image", filename: "Team photo.PNG", mimeType: "image/png", sizeBytes: files.photo.byteLength, width: 96, height: 64, storedBytes: files.photo.byteLength + variantBytes },
    });
    expect(outcomes[1]).toMatchObject({ status: "ready", media: { kind: "document", width: null, height: null, sizeBytes: 9_000, storedBytes: 9_000 } });
    expect((await rowsOfSite(ctx)).map((row) => row.status)).toEqual(["ready", "ready", "ready", "ready", "ready"]);
    expect(await platformStorage().head(photo.storageKey)).toEqual({ size: files.photo.byteLength, contentType: "image/png" });

    // Completing again (a retry) answers the same and records nothing more.
    expect(await completeUpload(ctx, photo.id)).toEqual(outcomes[0]);
    const events = await uploadEvents(ctx);
    expect(events).toHaveLength(5);
    expect(events.find((e) => e.resourceId === photo.id)).toMatchObject({
      resourceType: "media", siteId: ctx.site.id, actorId: a.user.id, metadata: { kind: "image", filename: "Team photo.PNG", sizeBytes: files.photo.byteLength },
    });
  });

  it("spoofed type: HTML sent as a PNG is deleted and failed, and stays failed; nothing is recorded", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const body = html(3_000);
    const { issued, outcome } = await upload(ctx, "innocent.png", body, "image/png");
    expect(outcome).toEqual({ status: "failed", mediaId: issued.mediaId, message: "innocent.png is not a PNG file. Upload JPEG, PNG, WebP, GIF or PDF files." });
    const row = (await rowOf(ctx, issued.mediaId))!;
    expect(row.status).toBe("failed");
    expect(await platformStorage().head(row.storageKey)).toBeNull();
    // A retry does not revive it, and a new PUT to its target cannot make it ready.
    expect(await completeUpload(ctx, issued.mediaId)).toEqual({ status: "failed", mediaId: issued.mediaId, message: "This upload was refused or has expired. Upload the file again." });
    expect(await uploadEvents(ctx)).toHaveLength(0);
  });

  it("a real file of another allowed type than declared (a JPEG named .png) is refused with what it is", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { outcome } = await upload(ctx, "photo.png", jpeg(), "image/png");
    expect(outcome).toMatchObject({ status: "failed", message: "photo.png is a JPEG file, but was sent as PNG. Give it the right extension and upload it again." });
    // A PDF sent as an image, and an image sent as a PDF.
    expect((await upload(ctx, "doc.jpg", pdf(2_000), "image/jpeg")).outcome).toMatchObject({ status: "failed", message: expect.stringMatching(/is a PDF file, but was sent as JPEG/) });
    expect((await upload(ctx, "scan.pdf", png(), "application/pdf")).outcome).toMatchObject({ status: "failed", message: expect.stringMatching(/is a PNG file, but was sent as PDF/) });
    // Too short to carry any signature.
    expect((await upload(ctx, "tiny.png", new Uint8Array([0x89, 0x50]), "image/png")).outcome).toMatchObject({ status: "failed" });
  });

  it("the target takes exactly the declared file, once: another size or type is refused, and a ready file cannot be replaced", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const body = png();
    const { uploads } = await requestUploads(ctx, [describeFile("a.png", body, "image/png")]);
    const target = uploads[0]!.upload;
    expect([400, 403]).toContain(await send(target, new Uint8Array(body.byteLength + 1)));
    expect([400, 403]).toContain(await send(target, body, { ...target.headers, "content-type": "text/html" }));
    const row = (await rowOf(ctx, uploads[0]!.mediaId))!;
    expect(await platformStorage().head(row.storageKey)).toBeNull();

    expect(await send(target, body)).toBe(200);
    expect((await completeUpload(ctx, row.id)).status).toBe("ready");
    // The link is still within its 10 minutes: sending other bytes of the same size and type changes nothing.
    expect(await send(target, html(body.byteLength))).toBe(412);
    expect(await send(target, body)).toBe(412); // a retry of the same PUT: refused, and harmless
    expect(await platformStorage().readRange(row.storageKey, 0, 7)).toEqual(body.subarray(0, 8));
  });

  it("completing before the file arrived is refused and changes nothing; after it arrives, it completes", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const body = pdf(5_000);
    const { uploads } = await requestUploads(ctx, [describeFile("late.pdf", body, "application/pdf")]);
    const refusal = await refusalOf(() => completeUpload(ctx, uploads[0]!.mediaId));
    expect(refusal).toMatchObject({ kind: "Conflict", message: "The file has not reached storage yet. Send it again, then finish the upload." });
    expect((await rowOf(ctx, uploads[0]!.mediaId))!.status).toBe("pending");
    expect(await send(uploads[0]!.upload, body)).toBe(200);
    expect((await completeUpload(ctx, uploads[0]!.mediaId)).status).toBe("ready");
  });

  it("HEAD size must match: an object of another size at the key (a store that ignored the signed length) is deleted and failed", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { uploads } = await requestUploads(ctx, [describeFile("short.png", await imageOf("png", 400, 300), "image/png")]);
    const row = (await rowOf(ctx, uploads[0]!.mediaId))!;
    await platformStorage().put(row.storageKey, png(), { contentType: "image/png" }); // a smaller real PNG
    expect(await completeUpload(ctx, row.id)).toMatchObject({ status: "failed", message: "short.png did not arrive as it was sent (its size differs). Upload it again." });
    expect(await platformStorage().head(row.storageKey)).toBeNull();
    expect((await rowOf(ctx, row.id))!.status).toBe("failed");
  });

  it("two completions at once: both answer ready, the row is ready once, recorded once", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    for (let round = 0; round < 3; round++) {
      const body = png();
      const { uploads } = await requestUploads(ctx, [describeFile(`race-${round}.png`, body, "image/png")]);
      expect(await send(uploads[0]!.upload, body)).toBe(200);
      const both = await Promise.all([completeUpload(ctx, uploads[0]!.mediaId), completeUpload(ctx, uploads[0]!.mediaId), completeUpload(ctx, uploads[0]!.mediaId)]);
      expect(both.map((o) => o.status)).toEqual(["ready", "ready", "ready"]);
      expect((await uploadEvents(ctx)).filter((e) => e.resourceId === uploads[0]!.mediaId)).toHaveLength(1);
    }
  });

  it("storage unavailable: no target, no row; no completion, the row stays pending; then it works", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const body = png();

    setStorageDriverForTests(failing(driver, ["createUpload"]));
    expect(await refusalOf(() => requestUploads(ctx, [describeFile("x.png", body, "image/png")]))).toMatchObject({ kind: "Unavailable" });
    expect(await rowsOfSite(ctx)).toHaveLength(0); // signing failed inside the transaction: nothing reserved

    working();
    const { uploads } = await requestUploads(ctx, [describeFile("x.png", body, "image/png")]);
    expect(await send(uploads[0]!.upload, body)).toBe(200);
    for (const broken of [["head"], ["readRange"]] as const) {
      setStorageDriverForTests(failing(driver, [...broken]));
      expect(await refusalOf(() => completeUpload(ctx, uploads[0]!.mediaId)), broken[0]).toMatchObject({ kind: "Unavailable" });
      expect((await rowOf(ctx, uploads[0]!.mediaId))!.status).toBe("pending");
    }
    // A refused file whose object cannot be deleted right now: still failed (never ready), deleted later by the cleanup.
    working();
    const spoof = html(2_000);
    const { uploads: [bad] } = await requestUploads(ctx, [describeFile("bad.png", spoof, "image/png")]);
    expect(await send(bad!.upload, spoof)).toBe(200);
    setStorageDriverForTests(failing(driver, ["delete"]));
    expect((await completeUpload(ctx, bad!.mediaId)).status).toBe("failed");
    const badRow = (await rowOf(ctx, bad!.mediaId))!;
    expect(badRow.status).toBe("failed");
    expect(await driver.head(badRow.storageKey)).not.toBeNull();

    working();
    expect((await completeUpload(ctx, uploads[0]!.mediaId)).status).toBe("ready");
    await age(ctx, bad!.mediaId);
    await cleanUpUploads();
    expect(await rowOf(ctx, bad!.mediaId)).toBeNull();
    expect(await driver.head(badRow.storageKey)).toBeNull();
  });

  it("a failed audit record rolls the completion back: still pending, object kept; completing again works", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const body = gif();
    const { uploads } = await requestUploads(ctx, [describeFile("anim.gif", body, "image/gif")]);
    expect(await send(uploads[0]!.upload, body)).toBe(200);
    await whileFailing("audit_logs", "insert", () => expect(completeUpload(ctx, uploads[0]!.mediaId)).rejects.toThrow());
    const row = (await rowOf(ctx, uploads[0]!.mediaId))!;
    expect(row.status).toBe("pending");
    expect(await platformStorage().head(row.storageKey)).not.toBeNull();
    expect((await completeUpload(ctx, row.id)).status).toBe("ready");
    expect(await uploadEvents(ctx)).toHaveLength(1);
  });

  it("uploads.cleanup: never-completed uploads past 24 h and refused ones go with their objects; ready and recent ones stay", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const b = await newTenant("Other");
    const { ctx: other } = await siteOf(b);

    const done = await upload(ctx, "kept.png", png(), "image/png");
    const refused = await upload(ctx, "spoof.png", html(2_000), "image/png");
    const abandoned = await requestUploads(ctx, [describeFile("abandoned.pdf", pdf(3_000), "application/pdf")]);
    expect(await send(abandoned.uploads[0]!.upload, pdf(3_000))).toBe(200); // sent, never completed
    const neverSent = await requestUploads(other, [describeFile("never.jpg", jpeg(), "image/jpeg")]);
    const recent = await requestUploads(ctx, [describeFile("recent.webp", webp(), "image/webp")]);
    const ids = { done: done.issued.mediaId, refused: refused.issued.mediaId, abandoned: abandoned.uploads[0]!.mediaId, neverSent: neverSent.uploads[0]!.mediaId, recent: recent.uploads[0]!.mediaId };
    for (const id of [ids.done, ids.refused, ids.abandoned]) await age(ctx, id);
    await age(other, ids.neverSent);
    const keys = { done: (await rowOf(ctx, ids.done))!.storageKey, abandoned: (await rowOf(ctx, ids.abandoned))!.storageKey };

    const result = await cleanUpUploads();
    expect(result.expired).toBeGreaterThanOrEqual(2);
    expect(result.kept).toBe(0);
    expect(await rowOf(ctx, ids.refused)).toBeNull();
    expect(await rowOf(ctx, ids.abandoned)).toBeNull();
    expect(await rowOf(other, ids.neverSent)).toBeNull();
    expect(await platformStorage().head(keys.abandoned)).toBeNull();
    expect((await rowOf(ctx, ids.done))!.status).toBe("ready");
    expect(await platformStorage().head(keys.done)).not.toBeNull();
    expect((await rowOf(ctx, ids.recent))!.status).toBe("pending");

    // A completion arriving after the cleanup expired its upload: refused, never ready without its object.
    expect(await refusalOf(() => completeUpload(ctx, ids.abandoned))).toMatchObject({ kind: "NotFound" });
    // Idempotent: nothing more to do.
    const again = await cleanUpUploads();
    expect((await rowOf(ctx, ids.done))!.status).toBe("ready");
    expect(again.kept).toBe(0);
  });

  it("uploads.cleanup racing a completion: the upload ends ready with its object, or failed and gone; never ready without it", async () => {
    working();
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    for (let round = 0; round < 4; round++) {
      const body = png();
      const { uploads } = await requestUploads(ctx, [describeFile(`r${round}.png`, body, "image/png")]);
      expect(await send(uploads[0]!.upload, body)).toBe(200);
      await age(ctx, uploads[0]!.mediaId);
      const key = (await rowOf(ctx, uploads[0]!.mediaId))!.storageKey;
      const [completion] = await Promise.allSettled([completeUpload(ctx, uploads[0]!.mediaId), cleanUpUploads()]);
      const row = await rowOf(ctx, uploads[0]!.mediaId);
      const object = await platformStorage().head(key);
      if (row?.status === "ready") {
        expect(object, `round ${round}`).not.toBeNull();
        expect(completion).toMatchObject({ status: "fulfilled", value: { status: "ready" } });
      } else {
        expect(completion.status === "rejected" || (completion.status === "fulfilled" && completion.value.status === "failed"), `round ${round}`).toBe(true);
        await cleanUpUploads();
        expect(await rowOf(ctx, uploads[0]!.mediaId)).toBeNull();
        expect(await platformStorage().head(key)).toBeNull();
      }
    }
  });
});

describe("what may be uploaded, and by whom (with the local driver)", () => {
  beforeAll(async () => setStorageDriverForTests(await localDriver()));

  it("type and size are checked for every file; one refused file refuses the request, and nothing is reserved", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const refused = async (files: unknown) => {
      const refusal = await refusalOf(() => requestUploads(ctx, files));
      expect(await rowsOfSite(ctx)).toHaveLength(0);
      return refusal;
    };
    expect(await refused([{ name: "big.jpg", size: 20 * MB + 1, type: "image/jpeg" }])).toMatchObject({ kind: "Validation", fieldErrors: { "files.0": ["big.jpg is 20 MB. Images can be at most 20 MB."] } });
    expect((await refused([{ name: "big.pdf", size: 25 * MB + 1, type: "application/pdf" }])).fieldErrors).toEqual({ "files.0": ["big.pdf is 25 MB. PDFs can be at most 25 MB."] });
    expect((await refused([{ name: "ok.png", size: 10, type: "image/png" }, { name: "logo.svg", size: 10, type: "image/svg+xml" }])).fieldErrors).toEqual({
      "files.1": ["logo.svg can't be uploaded. Upload JPEG, PNG, WebP, GIF or PDF files."],
    });
    for (const type of ["text/html", "application/javascript", "video/mp4", "application/zip", "image/heic", ""]) {
      expect((await refused([{ name: "x", size: 10, type }])).fieldErrors, type).toHaveProperty("files.0");
    }
    expect((await refused([{ name: "x.png", size: 0, type: "image/png" }])).fieldErrors).toEqual({ "files.0": ["x.png is empty."] });
    expect((await refused([{ name: "x.png", size: -5, type: "image/png" }])).fieldErrors).toEqual({ "files.0": ["The size of x.png is not valid."] });
    expect((await refused([])).fieldErrors).toEqual({ files: ["Choose at least one file."] });
    for (const notAList of [null, undefined, "x.png", 7, { name: "x.png", size: 1, type: "image/png" }]) expect((await refused(notAList)).kind).toBe("Validation");
    expect((await refused(Array.from({ length: 21 }, (_, i) => ({ name: `${i}.png`, size: 1, type: "image/png" })))).fieldErrors).toEqual({ files: ["Upload at most 20 files at a time."] });
    // At the limits exactly: accepted.
    const { uploads } = await requestUploads(ctx, [{ name: "max.jpg", size: 20 * MB, type: "image/jpeg" }, { name: "max.pdf", size: 25 * MB, type: "application/pdf" }]);
    expect(uploads).toHaveLength(2);
  });

  it("the file name is display text only: the key is made by the server, inside this site's prefix", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { uploads } = await requestUploads(ctx, [
      { name: "../../../etc/passwd.png", size: 10, type: "image/png" },
      { name: `o/${uuidv7()}/s/${uuidv7()}/m/x.png`, size: 10, type: "image/png" },
      { name: "photo.png", size: 10, type: "image/png" },
      { name: "photo.png", size: 10, type: "image/png" },
      { name: "東京タワー.jpg", size: 10, type: "image/jpeg" },
      { name: "evil.png.html", size: 10, type: "image/png" },
    ]);
    const rows = await rowsOfSite(ctx);
    const prefix = `o/${ctx.org.id}/s/${ctx.site.id}/m/`;
    for (const row of rows) {
      expect(row.storageKey.startsWith(`${prefix}${row.id}/v1/original/`), row.storageKey).toBe(true);
      expect(row.storageKey).toMatch(/^[a-z0-9/-]+\.(png|jpg)$/);
    }
    expect(rows.map((row) => row.originalFilename).sort()).toEqual(["evil.png.html", "passwd.png", "photo.png", "photo.png", "x.png", "東京タワー.jpg"].sort());
    expect(new Set(rows.map((row) => row.storageKey)).size).toBe(6); // the same name twice: two keys
    expect(rows.find((row) => row.originalFilename === "evil.png.html")!.storageKey).toMatch(/\/evil-png\.png$/); // the type decides the extension
    expect(uploads.every((u) => !u.upload.url.includes("..") && !u.upload.url.includes("etc/passwd"))).toBe(true);
  });

  it("media.upload: Owner to Author may; a Viewer may not, and nothing is created", async () => {
    const a = await newTenant();
    const { site, ctx } = await siteOf(a);
    for (const role of ["admin", "editor", "author"] as const) {
      const member = await addMember(a.org, role);
      const { uploads } = await requestUploads(await asMember(member, a, site), [{ name: `${role}.png`, size: 10, type: "image/png" }]);
      expect(uploads, role).toHaveLength(1);
    }
    const viewer = await addMember(a.org, "viewer");
    const viewerCtx = await asMember(viewer, a, site);
    const before = (await rowsOfSite(ctx)).length;
    expect(await refusalOf(() => requestUploads(viewerCtx, [{ name: "v.png", size: 10, type: "image/png" }]))).toMatchObject({ kind: "Forbidden" });
    const someUpload = (await rowsOfSite(ctx))[0]!.id;
    expect(await refusalOf(() => completeUpload(viewerCtx, someUpload))).toMatchObject({ kind: "Forbidden" });
    expect(await rowsOfSite(ctx)).toHaveLength(before);
  });

  it("completing is the uploader's own step: another member, even the Owner, is told there is no such upload; nobody completes an orphan", async () => {
    const a = await newTenant();
    const { site, ctx } = await siteOf(a);
    const author = await addMember(a.org, "author");
    const authorCtx = await asMember(author, a, site);
    const body = png();
    const { uploads } = await requestUploads(authorCtx, [describeFile("mine.png", body, "image/png")]);
    expect(await send(uploads[0]!.upload, body)).toBe(200);
    const editorCtx = await asMember(await addMember(a.org, "editor"), a, site);
    for (const other of [ctx, editorCtx]) expect(await refusalOf(() => completeUpload(other, uploads[0]!.mediaId))).toMatchObject({ kind: "NotFound" });
    expect((await rowOf(ctx, uploads[0]!.mediaId))!.status).toBe("pending");

    // The uploader's account is gone (`uploaded_by` set to NULL): nobody's own, so nobody completes it. The cleanup will.
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ uploadedBy: null }).where(eq(t.mediaAssets.id, uploads[0]!.mediaId)));
    for (const anyone of [ctx, editorCtx, authorCtx]) expect(await refusalOf(() => completeUpload(anyone, uploads[0]!.mediaId))).toMatchObject({ kind: "NotFound" });
  });

  it("another site of the same organization, and another organization: no such upload", async () => {
    const a = await newTenant();
    const { ctx: first } = await siteOf(a, "First");
    const { ctx: second } = await siteOf(a, "Second");
    const b = await newTenant("Other");
    const { ctx: elsewhere } = await siteOf(b);
    const body = png();
    const { uploads } = await requestUploads(first, [describeFile("first.png", body, "image/png")]);
    expect(await send(uploads[0]!.upload, body)).toBe(200);
    expect(await refusalOf(() => completeUpload(second, uploads[0]!.mediaId))).toMatchObject({ kind: "NotFound" });
    expect(await refusalOf(() => completeUpload(elsewhere, uploads[0]!.mediaId))).toMatchObject({ kind: "NotFound" });
    expect((await rowOf(first, uploads[0]!.mediaId))!.status).toBe("pending");
    expect((await completeUpload(first, uploads[0]!.mediaId)).status).toBe("ready");
  });

  it("an id that is not an upload is not found, whatever it is", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { entry } = await createEntry(ctx, { type: "page", title: "Not media" });
    for (const id of ["not-a-uuid", "", 42, null, undefined, { id: uuidv7() }, uuidv7(), entry.id, ctx.site.id, ctx.org.id, "00000000-0000-0000-0000-000000000000'; drop table media_assets; --"]) {
      expect(await refusalOf(() => completeUpload(ctx, id)), String(id)).toMatchObject({ kind: "NotFound" });
    }
  });

  it("a database failure leaves no reservation: before the insert, or when the transaction commits after signing", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const files = [{ name: "a.png", size: 10, type: "image/png" }];
    await whileFailing("media_assets", "insert", () => expect(requestUploads(ctx, files)).rejects.toThrow());
    await whileFailing("media_assets", "insert", () => expect(requestUploads(ctx, files)).rejects.toThrow(), { atCommit: true });
    expect(await rowsOfSite(ctx)).toHaveLength(0);
  });
});

describe("the storage limit (Free 1 GB, Pro and trial 20 GB)", () => {
  beforeAll(async () => setStorageDriverForTests(await localDriver()));

  it("counts pending, ready and trashed uploads, not failed ones; refuses what would pass it, as a whole request", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    await setPlan(a.org.id, "free");
    await fill(ctx, GB - 30 * MB); // ready
    await fill(ctx, 5 * MB, "pending");
    await fill(ctx, 5 * MB, "ready", true); // trashed: its object is still stored
    await fill(ctx, 500 * MB, "failed"); // given back
    // 20 MB left.
    const refusal = await refusalOf(() => requestUploads(ctx, [{ name: "a.jpg", size: 15 * MB, type: "image/jpeg" }, { name: "b.jpg", size: 6 * MB, type: "image/jpeg" }]));
    expect(refusal).toMatchObject({
      kind: "LimitExceeded", entitlement: "storage",
      message: "The Free plan includes 1 GB of storage, and these files would take this organization past it (1004 MB used).",
    });
    expect((await rowsOfSite(ctx)).filter((row) => row.originalFilename !== "filler.pdf")).toHaveLength(0);
    const { uploads } = await requestUploads(ctx, [{ name: "a.jpg", size: 15 * MB, type: "image/jpeg" }, { name: "b.jpg", size: 5 * MB, type: "image/jpeg" }]);
    expect(uploads).toHaveLength(2); // exactly to the last byte
    expect(await refusalOf(() => requestUploads(ctx, [{ name: "c.png", size: 1, type: "image/png" }]))).toMatchObject({ kind: "LimitExceeded" });

    // Pro (and the trial): 20 GB.
    await setPlan(a.org.id, "pro");
    expect((await requestUploads(ctx, [{ name: "c.png", size: 1, type: "image/png" }])).uploads).toHaveLength(1);
  });

  it("a failed upload gives its bytes back at once; an expired one when the cleanup expires it", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    await setPlan(a.org.id, "free");
    await fill(ctx, GB - 3_000);
    const spoof = html(2_000);
    const { uploads } = await requestUploads(ctx, [describeFile("x.png", spoof, "image/png")]);
    expect(await refusalOf(() => requestUploads(ctx, [{ name: "y.png", size: 2_000, type: "image/png" }]))).toMatchObject({ kind: "LimitExceeded" });
    expect(await send(uploads[0]!.upload, spoof)).toBe(200);
    expect((await completeUpload(ctx, uploads[0]!.mediaId)).status).toBe("failed");
    const { uploads: [pending] } = await requestUploads(ctx, [{ name: "y.png", size: 2_000, type: "image/png" }]);
    expect(await refusalOf(() => requestUploads(ctx, [{ name: "z.png", size: 2_000, type: "image/png" }]))).toMatchObject({ kind: "LimitExceeded" });
    await age(ctx, pending!.mediaId);
    await cleanUpUploads();
    expect((await requestUploads(ctx, [{ name: "z.png", size: 2_000, type: "image/png" }])).uploads).toHaveLength(1);
  });

  it("quota race: concurrent requests for the last room take turns; exactly one gets it, in every round", async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newTenant();
      const { site, ctx } = await siteOf(a);
      await setPlan(a.org.id, "free");
      await fill(ctx, GB - 20 * MB);
      const editor = await asMember(await addMember(a.org, "editor"), a, site);
      const attempts = await Promise.allSettled(
        [ctx, editor, ctx, editor, ctx].map((who, i) => requestUploads(who, [{ name: `race-${i}.jpg`, size: 15 * MB, type: "image/jpeg" }])),
      );
      expect(attempts.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      for (const r of attempts.filter((r) => r.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ kind: "LimitExceeded" });
      const counted = (await rowsOfSite(ctx)).filter((row) => row.status !== "failed").reduce((sum, row) => sum + row.sizeBytes, 0);
      expect(counted).toBe(GB - 5 * MB);
    }
  });
});

describe("attaching media to content: only a ready image of the same site", () => {
  beforeAll(async () => setStorageDriverForTests(await localDriver()));
  const imageBlock = (mediaId: string) => ({ type: "image", attrs: { id: uuidv7(), v: 1, mediaId, alt: "A photo", caption: null, size: "content", link: null } });
  const doc = (...content: unknown[]) => ({ v: 1, doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: uuidv7() }, content: [{ type: "text", text: "Hi" }] }, ...content] } });

  it("a pending, a refused, a PDF, a trashed item, another site's: refused in the document and as the featured image; a ready image of the site: saved", async () => {
    const a = await newTenant();
    const { ctx } = await siteOf(a, "Home site");
    const { ctx: sibling } = await siteOf(a, "Sibling");
    const pending = (await requestUploads(ctx, [{ name: "p.png", size: 10, type: "image/png" }])).uploads[0]!.mediaId;
    const refused = (await upload(ctx, "f.png", html(500), "image/png")).issued.mediaId;
    const document = (await upload(ctx, "menu.pdf", pdf(500), "application/pdf")).issued.mediaId;
    const trashed = (await upload(ctx, "old.png", png(), "image/png")).issued.mediaId;
    await withTenant({ orgId: a.org.id }, (tx) => tx.update(t.mediaAssets).set({ deletedAt: new Date() }).where(eq(t.mediaAssets.id, trashed)));
    const theirs = (await upload(sibling, "theirs.png", png(), "image/png")).issued.mediaId;
    const ready = (await upload(ctx, "ok.png", png(), "image/png")).issued.mediaId;

    const { entry } = await createEntry(ctx, { type: "post", title: "With media" });
    let version = 1;
    for (const [what, id] of Object.entries({ pending, refused, document, trashed, theirs, nothing: uuidv7() })) {
      expect(await refusalOf(() => saveDraft(ctx, entry.id, version, { content: doc(imageBlock(id)) })), `${what} in the document`).toMatchObject({
        kind: "Validation", fieldErrors: { content: ["An image is not one of this site's."] },
      });
      expect(await refusalOf(() => saveDraft(ctx, entry.id, version, { featuredMediaId: id })), `${what} as the featured image`).toMatchObject({
        kind: "Validation", fieldErrors: { featuredMediaId: ["Choose an image of this site."] },
      });
    }
    version = (await saveDraft(ctx, entry.id, version, { content: doc(imageBlock(ready)), featuredMediaId: ready })).version;
    // Already there: later saves do not check it again, and the cleanup never touches a ready item.
    await age(ctx, ready, 48);
    await cleanUpUploads();
    version = (await saveDraft(ctx, entry.id, version, { title: "Still with media" })).version;
    const [draft] = await inTenant(ctx, (tx) => tx.select({ featured: t.entryDrafts.featuredMediaId }).from(t.entryDrafts).where(eq(t.entryDrafts.entryId, entry.id)));
    expect(draft!.featured).toBe(ready);
  });
});

describe("the Server Actions' answers, the daily job, and the cache", () => {
  let driver: StorageDriver;
  beforeAll(async () => {
    driver = await localDriver();
    setStorageDriverForTests(driver);
  });

  it("submitRequestUploads / submitCompleteUpload: results, never a false success; the limit and refusals in words; nothing flushed", async () => {
    cacheCalls.calls.length = 0;
    const a = await newTenant();
    const { site, ctx } = await siteOf(a);
    const size = png().byteLength;
    const requested = await submitRequestUploads(a.actor, a.org.slug, site.slug, [{ name: "a.png", size, type: "image/png" }, { name: "b.png", size, type: "image/png" }]);
    if (!requested.ok) throw new Error(JSON.stringify(requested));
    const [good, bad] = requested.data.uploads;
    expect(await send(good!.upload, png())).toBe(200);
    expect(await send(bad!.upload, html(size))).toBe(200);
    const completed = await submitCompleteUpload(a.actor, a.org.slug, site.slug, good!.mediaId);
    const stored = size + (await rowOf(ctx, good!.mediaId))!.variantBytes;
    expect(completed).toEqual({
      ok: true, data: { id: good!.mediaId, kind: "image", filename: "a.png", mimeType: "image/png", sizeBytes: size, width: 96, height: 64, storedBytes: stored },
    });
    expect(await submitCompleteUpload(a.actor, a.org.slug, site.slug, bad!.mediaId)).toEqual({
      ok: false, code: "Validation", error: "b.png is not a PNG file. Upload JPEG, PNG, WebP, GIF or PDF files.", fieldErrors: { file: ["b.png is not a PNG file. Upload JPEG, PNG, WebP, GIF or PDF files."] },
    });
    expect(await submitRequestUploads(a.actor, a.org.slug, site.slug, [{ name: "x.svg", size: 10, type: "image/svg+xml" }])).toMatchObject({ ok: false, code: "Validation" });
    // Storage down: a refusal, not a success and not a crash.
    setStorageDriverForTests(failing(driver, ["createUpload"]));
    try {
      expect(await submitRequestUploads(a.actor, a.org.slug, site.slug, [{ name: "a.png", size: 1, type: "image/png" }])).toMatchObject({ ok: false, code: "Unavailable" });
    } finally {
      setStorageDriverForTests(driver);
    }
    await setPlan(a.org.id, "free");
    await fill(ctx, GB - stored); // with a.png and its variants: full (b.png, refused, counts for nothing)
    expect(await submitRequestUploads(a.actor, a.org.slug, site.slug, [{ name: "x.pdf", size: 1, type: "application/pdf" }])).toMatchObject({
      ok: false, code: "LimitExceeded", error: expect.stringContaining("The Free plan includes 1 GB of storage"),
    });
    expect(await submitRequestUploads({ kind: "anonymous" }, a.org.slug, site.slug, [{ name: "a.png", size: 1, type: "image/png" }])).toMatchObject({ ok: false, code: "Unauthenticated" });
    expect(await submitCompleteUpload(a.actor, a.org.slug, "no-such-site", good!.mediaId)).toMatchObject({ ok: false, code: "NotFound" });
    expect(cacheCalls.calls).toEqual([]);
  });

  it("uploads.cleanup is a daily job; it reports objects it could not delete by failing, and a later run removes them", async () => {
    expect(jobRegistry.get("uploads.cleanup")).toBe(uploadsCleanup);
    expect(DAILY_JOBS.map((job) => job.type)).toContain("uploads.cleanup");
    const a = await newTenant();
    const { ctx } = await siteOf(a);
    const { uploads } = await requestUploads(ctx, [describeFile("gone.png", png(), "image/png")]);
    expect(await send(uploads[0]!.upload, png())).toBe(200);
    await age(ctx, uploads[0]!.mediaId);
    const key = (await rowOf(ctx, uploads[0]!.mediaId))!.storageKey;
    const jobContext = {
      job: { id: uuidv7(), type: "uploads.cleanup", attempt: 1, maxAttempts: 5 }, orgId: null, log: logger,
      withTenant: () => Promise.reject(new Error("a platform job has no tenant")),
    };

    setStorageDriverForTests(failing(driver, ["delete"]));
    await expect(uploadsCleanup.run({}, jobContext)).rejects.toThrow(/could not be deleted/);
    expect((await rowOf(ctx, uploads[0]!.mediaId))!.status).toBe("failed"); // expired: no longer counted, never completable
    expect(await driver.head(key)).not.toBeNull();

    setStorageDriverForTests(driver);
    await uploadsCleanup.run({}, jobContext);
    expect(await rowOf(ctx, uploads[0]!.mediaId)).toBeNull();
    expect(await driver.head(key)).toBeNull();
  });
});
