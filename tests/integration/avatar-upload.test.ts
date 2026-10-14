import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jobRegistry } from "@/app/api/internal/cron/jobs";
import { ownAvatarUrl } from "@/modules/auth";
import { avatarsCollect, completeAvatarUpload, requestAvatarUpload, submitCompleteAvatarUpload, submitRequestAvatarUpload, type IssuedAvatarUpload } from "@/modules/media";
import * as t from "@/platform/db/schema";
import { withPlatform } from "@/platform/db/tenant";
import { jobs } from "@/platform/jobs/schema";
import { logger } from "@/platform/observability";
import { platformStorage, type StorageDriver } from "@/platform/storage";
import { setStorageDriverForTests } from "@/platform/storage/get-driver";
import { createUser } from "../fixtures/factories";
import { DRIVERS, fileOf, hasGps, html, imageOf, phonePhoto, removeTempDirs, send } from "../fixtures/media";
import { actorOf, refusalOf } from "../fixtures/tenants";

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {} }));
const { GET } = await import("@/app/media/[...key]/route");

/**
 * M6-2, the account avatar (moved from M2-4), against real Postgres and both storage drivers: uploaded straight to
 * storage under the user's own prefix, checked and processed like other media (a square of 400, WebP, metadata
 * stripped), served from /media only while it is the user's picture, and every object it ever wrote collected.
 */

afterAll(async () => {
  setStorageDriverForTests(null);
  await removeTempDirs();
});

const imageOfUser = async (userId: string) => (await withPlatform((tx) => tx.select({ image: t.users.image }).from(t.users).where(eq(t.users.id, userId))))[0]!.image;
const collectJobs = (userId: string) =>
  withPlatform((tx) =>
    tx
      .select({ payload: jobs.payload, runAt: jobs.runAt, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.type, "avatars.collect"), sql`${jobs.payload}->>'userId' = ${userId}`))
      .orderBy(jobs.runAt),
  );
const runCollect = (payload: { userId: string; key: string }) =>
  avatarsCollect.run(payload, { job: { id: uuidv7(), type: "avatars.collect", attempt: 1, maxAttempts: 5 }, orgId: null, log: logger, withTenant: () => Promise.reject(new Error("none")) });
const get = (key: string) => GET(new Request(`http://localhost:3000/media/${key}`), { params: Promise.resolve({ key: key.split("/") }) });
const keyOf = (url: string) => url.slice(url.indexOf("/media/") + "/media/".length);

async function avatar(userId: string, bytes: Uint8Array, type: string): Promise<{ issued: IssuedAvatarUpload; url: string }> {
  const issued = await requestAvatarUpload(userId, { name: "me.jpg", size: bytes.byteLength, type });
  expect(await send(issued.upload, bytes)).toBe(200);
  return { issued, ...(await completeAvatarUpload(userId, issued.avatarId)) };
}

describe.each(DRIVERS)("the account avatar with the %s driver", (_name, make) => {
  let driver: StorageDriver;
  beforeAll(async () => {
    driver = await make();
  });
  const working = () => setStorageDriverForTests(driver);

  it("a phone photo becomes a 400 square WebP without metadata; the picture points at it; the original is gone; every object is tracked", async () => {
    working();
    const user = await createUser();
    const photo = await phonePhoto(1600, 1200);
    const before = Date.now();
    const { issued, url } = await avatar(user.id, photo, "image/jpeg");
    expect(issued.upload.url).toContain(`u/${user.id}/a/${issued.avatarId}/original/avatar.upload`);
    expect(url).toBe(`http://localhost:3000/media/u/${user.id}/a/${issued.avatarId}/thumb/avatar.webp`);
    expect(await imageOfUser(user.id)).toBe(url);
    expect(ownAvatarUrl({ id: user.id, image: url })).toBe(url);

    const thumb = new Uint8Array(await new Response((await platformStorage().get(keyOf(url))).body).arrayBuffer());
    const meta = await sharp(thumb).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height, exif: meta.exif, xmp: meta.xmp }).toEqual({ format: "webp", width: 400, height: 400, exif: undefined, xmp: undefined });
    expect(hasGps((await sharp(photo).metadata()).exif)).toBe(true);
    expect(await platformStorage().head(`u/${user.id}/a/${issued.avatarId}/original/avatar.upload`)).toBeNull();

    const served = await get(keyOf(url));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // The original and the thumbnail were each tracked before they could exist: collected in an hour unless current.
    const queued = await collectJobs(user.id);
    expect(queued.map((job) => (job.payload as { key: string }).key)).toEqual([
      `u/${user.id}/a/${issued.avatarId}/original/avatar.upload`, `u/${user.id}/a/${issued.avatarId}/thumb/avatar.webp`,
    ]);
    for (const job of queued) expect(job.runAt.getTime()).toBeGreaterThan(before + 59 * 60_000);
  });

  it("a new picture replaces the old: the old one is no longer served and is collected at once; the current one is kept", async () => {
    working();
    const user = await createUser();
    const first = await avatar(user.id, await imageOf("png", 500, 500), "image/png");
    const second = await avatar(user.id, await imageOf("jpeg", 300, 200), "image/jpeg");
    expect(await imageOfUser(user.id)).toBe(second.url);
    expect((await get(keyOf(first.url))).status).toBe(404); // not the user's picture any more, before it is even deleted
    const square = await sharp(new Uint8Array(await (await get(keyOf(second.url))).arrayBuffer())).metadata();
    expect([square.width, square.height]).toEqual([200, 200]); // never upscaled: the shorter side

    const queued = await collectJobs(user.id);
    const replaced = queued.find((job) => (job.payload as { key: string }).key === keyOf(first.url) && job.runAt.getTime() < Date.now() + 60_000);
    expect(replaced, "the replaced picture is queued for now").toBeDefined();
    for (const job of queued) await runCollect(job.payload as { userId: string; key: string });
    expect(await platformStorage().head(keyOf(first.url))).toBeNull();
    expect(await platformStorage().head(keyOf(second.url))).not.toBeNull(); // still the picture: kept
    expect((await get(keyOf(second.url))).status).toBe(200);
  });

  it("refused: not an image, not what it claims, undecodable, not there yet, not an id; nothing changes", async () => {
    working();
    const user = await createUser();
    const current = await avatar(user.id, await imageOf("png", 200, 200), "image/png");
    expect(await refusalOf(() => requestAvatarUpload(user.id, { name: "cv.pdf", size: 10, type: "application/pdf" }))).toMatchObject({ kind: "Validation", message: expect.stringMatching(/A picture is an image/) });
    expect(await refusalOf(() => requestAvatarUpload(user.id, { name: "logo.svg", size: 10, type: "image/svg+xml" }))).toMatchObject({ kind: "Validation" });
    expect(await refusalOf(() => requestAvatarUpload(user.id, { name: "big.jpg", size: 20 * 1024 * 1024 + 1, type: "image/jpeg" }))).toMatchObject({ kind: "Validation" });

    for (const [bytes, type, message] of [
      [html(1_500), "image/png", /is not a PNG file/],
      [fileOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 1_500), "image/png", /could not be (read|processed) as an image/],
    ] as const) {
      const issued = await requestAvatarUpload(user.id, { name: "x.png", size: bytes.byteLength, type });
      expect(await send(issued.upload, bytes)).toBe(200);
      expect(await refusalOf(() => completeAvatarUpload(user.id, issued.avatarId))).toMatchObject({ kind: "Validation", message: expect.stringMatching(message) });
      expect(await platformStorage().head(`u/${user.id}/a/${issued.avatarId}/original/avatar.upload`)).toBeNull();
      expect(await platformStorage().head(`u/${user.id}/a/${issued.avatarId}/thumb/avatar.webp`)).toBeNull();
    }
    const notSent = await requestAvatarUpload(user.id, { name: "x.png", size: 100, type: "image/png" });
    expect(await refusalOf(() => completeAvatarUpload(user.id, notSent.avatarId))).toMatchObject({ kind: "Conflict" });
    for (const id of ["nope", 7, null, "../x"]) expect(await refusalOf(() => completeAvatarUpload(user.id, id))).toMatchObject({ kind: "NotFound" });
    expect(await imageOfUser(user.id)).toBe(current.url);
  });

  it("another user's upload is out of reach: completing their id looks only in one's own space; their picture is untouched", async () => {
    working();
    const [mine, theirs] = [await createUser(), await createUser()];
    const bytes = await imageOf("png", 300, 300);
    const issued = await requestAvatarUpload(theirs.id, { name: "t.png", size: bytes.byteLength, type: "image/png" });
    expect(await send(issued.upload, bytes)).toBe(200);
    expect(await refusalOf(() => completeAvatarUpload(mine.id, issued.avatarId))).toMatchObject({ kind: "Conflict" });
    expect(await imageOfUser(mine.id)).toBeNull();
    expect(await imageOfUser(theirs.id)).toBeNull();
    expect((await completeAvatarUpload(theirs.id, issued.avatarId)).url).toContain(`/u/${theirs.id}/`);
    // Someone else's current picture, named under one's own id, is not served.
    expect((await get(keyOf((await imageOfUser(theirs.id))!).replace(`u/${theirs.id}/`, `u/${mine.id}/`))).status).toBe(404);
  });

  it("two completions at once: both answer the same picture", async () => {
    working();
    const user = await createUser();
    const bytes = await imageOf("webp", 600, 400);
    const issued = await requestAvatarUpload(user.id, { name: "a.webp", size: bytes.byteLength, type: "image/webp" });
    expect(await send(issued.upload, bytes)).toBe(200);
    const results = await Promise.allSettled([completeAvatarUpload(user.id, issued.avatarId), completeAvatarUpload(user.id, issued.avatarId)]);
    const urls = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ url: string }>).value.url);
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(urls).size).toBe(1);
    expect(await imageOfUser(user.id)).toBe(urls[0]);
  });
});

describe("the avatar's actions and job", () => {
  beforeAll(async () => setStorageDriverForTests(await (await import("../fixtures/media")).localDriver()));

  it("signed in only; the result names nothing the browser could forge", async () => {
    expect(await submitRequestAvatarUpload({ kind: "anonymous" }, { name: "a.png", size: 1, type: "image/png" })).toMatchObject({ ok: false, code: "Unauthenticated" });
    expect(await submitCompleteAvatarUpload({ kind: "anonymous" }, uuidv7())).toMatchObject({ ok: false, code: "Unauthenticated" });
    const user = await createUser();
    const bytes = await imageOf("png", 120, 120);
    const requested = await submitRequestAvatarUpload(actorOf(user), { name: "a.png", size: bytes.byteLength, type: "image/png", url: "https://evil.example/x.png", key: "u/other/x" });
    if (!requested.ok) throw new Error(JSON.stringify(requested));
    expect(requested.data.upload.url).toContain(`/u/${user.id}/a/${requested.data.avatarId}/original/avatar.upload`);
    expect(await send(requested.data.upload, bytes)).toBe(200);
    expect(await submitCompleteAvatarUpload(actorOf(user), requested.data.avatarId)).toEqual({ ok: true, data: { url: `http://localhost:3000/media/u/${user.id}/a/${requested.data.avatarId}/thumb/avatar.webp` } });
  });

  it("avatars.collect is registered, and refuses a key outside the user's own avatars", async () => {
    expect(jobRegistry.get("avatars.collect")).toBe(avatarsCollect);
    const user = await createUser();
    for (const key of [`u/${uuidv7()}/a/${uuidv7()}/thumb/avatar.webp`, `o/${uuidv7()}/s/${uuidv7()}/m/${uuidv7()}/v1/thumb/x.webp`, "../../etc/passwd", `u/${user.id}/../x`]) {
      expect(avatarsCollect.payload.safeParse({ userId: user.id, key }).success, key).toBe(false);
    }
    expect(avatarsCollect.payload.safeParse({ userId: user.id, key: `u/${user.id}/a/${uuidv7()}/thumb/avatar.webp` }).success).toBe(true);
  });
});
