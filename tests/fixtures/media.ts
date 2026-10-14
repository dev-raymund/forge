import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { handleLocalUpload, StorageError, type StorageDriver } from "@/platform/storage";
import { LocalStorageDriver } from "@/platform/storage/providers/local";
import { S3StorageDriver } from "@/platform/storage/providers/s3";

/**
 * Media test helpers (M6-2): the two storage drivers (a temp directory; RustFS over the S3 API, as Cloudflare R2
 * would be, unless TEST_S3_* points elsewhere), real images made with sharp, and the browser's PUT.
 */

export const APP = "http://localhost:3000";
const publicBaseUrl = () => `${APP}/media`;
const tempDirs: string[] = [];

export async function localDriver(): Promise<StorageDriver> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-media-"));
  tempDirs.push(dir);
  return new LocalStorageDriver({ root: dir, appOrigin: () => APP, publicBaseUrl });
}

export async function s3Driver(): Promise<StorageDriver> {
  const config = {
    driver: "s3" as const,
    endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000",
    region: process.env.TEST_S3_REGION ?? "auto",
    bucket: process.env.TEST_S3_BUCKET ?? `forge-test-w${process.env.VITEST_POOL_ID ?? "1"}`,
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "forge",
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "forge-secret-key",
    forcePathStyle: true,
  };
  if (!process.env.TEST_S3_BUCKET) {
    const client = new S3Client({ endpoint: config.endpoint, region: "auto", forcePathStyle: true, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
    await client.send(new CreateBucketCommand({ Bucket: config.bucket })).catch((e: { name?: string }) => {
      if (!/BucketAlready/.test(e.name ?? "")) throw e;
    });
  }
  return new S3StorageDriver({ ...config, publicBaseUrl });
}

export const removeTempDirs = () => Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));

export const DRIVERS = [
  ["local filesystem", localDriver],
  ["s3-compatible (RustFS)", s3Driver],
] as const;

/** A real image of this format and size (a flat colour; sharp makes it). */
export const imageOf = async (format: "png" | "jpeg" | "webp" | "gif", width = 96, height = 64, background = { r: 40, g: 120, b: 90 }) =>
  new Uint8Array(await sharp({ create: { width, height, channels: 3, background } })[format]().toBuffer());

/** A JPEG taken by a phone: EXIF with GPS coordinates, and rotated a quarter by its orientation flag (6). */
export const phonePhoto = async (width = 3000, height = 2000) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 50 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 51/1 2981/100", GPSLongitudeRef: "E", GPSLongitude: "2/1 17/1 4000/100" } })
      .toBuffer(),
  );

/** An animated GIF of `frames` frames. */
export async function animatedGif(frames = 3, width = 120, height = 80): Promise<Uint8Array> {
  const colours = ["#e33", "#3e3", "#33e", "#ee3", "#3ee"];
  const stills = await Promise.all(
    Array.from({ length: frames }, (_, i) => sharp({ create: { width, height, channels: 3, background: colours[i % colours.length]! } }).png().toBuffer()),
  );
  return new Uint8Array(await sharp(stills, { join: { animated: true } }).gif({ delay: Array(frames).fill(100) }).toBuffer());
}

/** Does this EXIF block hold a GPS section (tag 0x8825, either byte order)? */
export const hasGps = (exif: Buffer | undefined) => !!exif && /\x88\x25|\x25\x88/.test(exif.toString("latin1"));

/** Bytes that start with a signature and are nothing after it: a fake no decoder accepts, or a document. */
export const fileOf = (signature: number[] | string, size: number, fill = 0x20) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set(typeof signature === "string" ? [...signature].map((c) => c.charCodeAt(0)) : signature);
  return bytes;
};
export const pdf = (size = 2_048) => fileOf("%PDF-1.7\n", size);
export const html = (size = 2_048) => fileOf("<!doctype html><script>alert(document.cookie)</script>", size);

/** The browser's part: PUT the bytes to the target with its headers. The local driver's route is called in-process. */
export async function send(target: { url: string; headers: Record<string, string> }, body: Uint8Array, headers: Record<string, string> = target.headers): Promise<number> {
  if (target.url.startsWith(`${APP}/api/storage/local/`)) {
    const request = new Request(target.url, { method: "PUT", headers, body: body as BodyInit });
    return (await handleLocalUpload(request, new URL(target.url).pathname.replace(/^\/api\/storage\/local\//, ""))).status;
  }
  return (await fetch(target.url, { method: "PUT", headers, body: body as BodyInit })).status;
}

/** The real driver, with some operations failing as an unreachable store would. */
export function failing(base: StorageDriver, ops: ("put" | "get" | "head" | "readRange" | "delete" | "createUpload")[]): StorageDriver {
  const down = async (): Promise<never> => {
    throw new StorageError("Unavailable", "Storage is unavailable (test)");
  };
  return {
    name: base.name,
    put: ops.includes("put") ? down : (key, body, options) => base.put(key, body, options),
    get: ops.includes("get") ? down : (key) => base.get(key),
    head: ops.includes("head") ? down : (key) => base.head(key),
    readRange: ops.includes("readRange") ? down : (key, start, end) => base.readRange(key, start, end),
    delete: ops.includes("delete") ? down : (key) => base.delete(key),
    createUpload: ops.includes("createUpload") ? down : (input) => base.createUpload(input),
    publicUrl: (key) => base.publicUrl(key),
  };
}
