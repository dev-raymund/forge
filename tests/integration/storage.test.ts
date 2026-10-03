import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mediaAssets } from "@/platform/db/schema";
import { withTenant } from "@/platform/db/tenant";
import {
  handleLocalUpload, mediaObjectKey, platformStorage, storageFor, type StorageDriver, type UploadTarget,
} from "@/platform/storage";
import { getStorageDriver, setStorageDriverForTests } from "@/platform/storage/get-driver";
import { LocalStorageDriver } from "@/platform/storage/providers/local";
import { S3StorageDriver } from "@/platform/storage/providers/s3";
import { createTenantGraph } from "../fixtures/factories";

/**
 * M1-5: one storage contract, two drivers. The local driver uses a temp
 * directory; the S3 driver talks to the RustFS container from docker-compose
 * (S3 API, like Cloudflare R2) unless TEST_S3_* points elsewhere. No cloud
 * account is needed.
 */

const APP = "http://localhost:3000";
const publicBaseUrl = () => `${APP}/media`;
// Defaults: the RustFS container. Set TEST_S3_* to run the same contract against another
// S3 API, e.g. a Cloudflare R2 test bucket (which must already exist).
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
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-storage-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const ORG_A = uuidv7();
const ORG_B = uuidv7();
const SITE = uuidv7();
const keyFor = (organizationId = ORG_A, ext = "bin") =>
  mediaObjectKey({ organizationId, siteId: SITE, mediaId: uuidv7(), version: 1, variant: "original", name: "photo", ext });
const bytes = (text: string) => new TextEncoder().encode(text);
const drain = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());
const code = (c: string) => expect.objectContaining({ code: c });

const makers: [string, () => Promise<StorageDriver>][] = [
  ["local filesystem", async () => new LocalStorageDriver({ root: await tempDir(), appOrigin: () => APP, publicBaseUrl })],
  [
    "s3-compatible",
    async () => {
      const client = new S3Client({
        endpoint: s3Config.endpoint,
        region: "auto",
        forcePathStyle: true,
        credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey },
      });
      if (!process.env.TEST_S3_BUCKET) {
        await client.send(new CreateBucketCommand({ Bucket: s3Config.bucket })).catch((e: { name?: string }) => {
          if (!/BucketAlready/.test(e.name ?? "")) throw e;
        });
      }
      return new S3StorageDriver({ ...s3Config, publicBaseUrl });
    },
  ],
];

describe.each(makers)("StorageDriver contract: %s", (_name, make) => {
  let driver: StorageDriver;
  beforeAll(async () => {
    driver = await make();
  });
  afterEach(() => setStorageDriverForTests(null));

  /** Sends bytes to an upload target the way a browser would. */
  async function upload(target: UploadTarget, body: Uint8Array, headers = target.headers, url = target.url) {
    if (driver.name === "local") {
      setStorageDriverForTests(driver);
      const request = new Request(url, { method: "PUT", headers, body: body as BodyInit });
      return handleLocalUpload(request, new URL(url).pathname.replace(/^\/api\/storage\/local\//, ""));
    }
    return fetch(url, { method: "PUT", headers, body: body as BodyInit });
  }

  it("puts an object and reads it back, preserving content type and size", async () => {
    const key = keyFor();
    const body = bytes("hello, forge");
    await driver.put(key, body, { contentType: "text/plain; charset=utf-8", cacheControl: "public, max-age=31536000, immutable" });
    const got = await driver.get(key);
    expect(await drain(got.body)).toEqual(body);
    expect(got.info).toEqual({ size: body.byteLength, contentType: "text/plain; charset=utf-8" });
    expect(await driver.head(key)).toEqual({ size: body.byteLength, contentType: "text/plain; charset=utf-8" });
  });

  it("stores binary data byte for byte", async () => {
    const key = keyFor(ORG_A, "png");
    const body = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    await driver.put(key, body, { contentType: "image/png" });
    expect(await drain((await driver.get(key)).body)).toEqual(body);
    expect((await driver.head(key))?.size).toBe(70_000);
  });

  it("reports existence through head: info for an object, null for none", async () => {
    const key = keyFor();
    expect(await driver.head(key)).toBeNull();
    await driver.put(key, bytes("x"), { contentType: "application/octet-stream" });
    expect(await driver.head(key)).not.toBeNull();
  });

  it("reads a byte range (for magic-byte sniffing)", async () => {
    const key = keyFor();
    await driver.put(key, bytes("0123456789"), { contentType: "application/octet-stream" });
    expect(new TextDecoder().decode(await driver.readRange(key, 0, 3))).toBe("0123");
    expect(new TextDecoder().decode(await driver.readRange(key, 6, 4095))).toBe("6789"); // shorter than asked
  });

  it("never overwrites: a second put to the same key is AlreadyExists and changes nothing", async () => {
    const key = keyFor();
    await driver.put(key, bytes("first"), { contentType: "text/plain" });
    await expect(driver.put(key, bytes("second"), { contentType: "text/html" })).rejects.toEqual(code("AlreadyExists"));
    expect(new TextDecoder().decode(await drain((await driver.get(key)).body))).toBe("first");
    expect((await driver.head(key))?.contentType).toBe("text/plain");
  });

  it("deletes an object; afterwards it can't be read, and deleting again is fine", async () => {
    const key = keyFor();
    await driver.put(key, bytes("bye"), { contentType: "text/plain" });
    await driver.delete(key);
    expect(await driver.head(key)).toBeNull();
    await expect(driver.get(key)).rejects.toEqual(code("NotFound"));
    await expect(driver.readRange(key, 0, 10)).rejects.toEqual(code("NotFound"));
    await expect(driver.delete(key)).resolves.toBeUndefined();
  });

  it("a missing object is NotFound on get and readRange", async () => {
    const key = keyFor();
    await expect(driver.get(key)).rejects.toEqual(code("NotFound"));
    await expect(driver.readRange(key, 0, 10)).rejects.toEqual(code("NotFound"));
  });

  it.each(["../../secret", "../other-tenant/file", "/etc/passwd", "%2e%2e%2fsecret", `o/${ORG_A}/../${ORG_B}/x`, "o/a\\..\\b"])(
    "rejects the key %j on every operation",
    async (key) => {
      const invalid = code("InvalidKey");
      await expect(driver.put(key, bytes("x"), { contentType: "text/plain" })).rejects.toEqual(invalid);
      await expect(driver.get(key)).rejects.toEqual(invalid);
      await expect(driver.head(key)).rejects.toEqual(invalid);
      await expect(driver.readRange(key, 0, 1)).rejects.toEqual(invalid);
      await expect(driver.delete(key)).rejects.toEqual(invalid);
      await expect(driver.createUpload({ key, contentType: "image/png", contentLength: 1, expiresInSeconds: 60 })).rejects.toEqual(invalid);
      expect(() => driver.publicUrl(key)).toThrow(invalid);
    },
  );

  it("gives the public URL from configuration, not from the storage location", () => {
    const key = keyFor(ORG_A, "webp");
    expect(driver.publicUrl(key)).toBe(`${APP}/media/${key}`);
  });

  describe("direct upload (createUpload)", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    it("round trip: the client PUTs exactly the signed bytes and type; the object is then readable", async () => {
      const key = keyFor(ORG_A, "png");
      const target = await driver.createUpload({ key, contentType: "image/png", contentLength: png.byteLength, expiresInSeconds: 300 });
      expect(target.kind).toBe("presigned-put");
      expect(target.headers).toEqual({ "content-type": "image/png" });
      expect(target.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(await driver.head(key)).toBeNull(); // nothing exists until the client uploads

      const res = await upload(target, png);
      expect(res.status).toBe(200);
      expect(await driver.head(key)).toEqual({ size: png.byteLength, contentType: "image/png" });
      expect(await driver.readRange(key, 0, 7)).toEqual(png.subarray(0, 8)); // the PNG signature
    });

    it("rejects a body of a different length, and stores nothing", async () => {
      const key = keyFor(ORG_A, "png");
      const target = await driver.createUpload({ key, contentType: "image/png", contentLength: png.byteLength, expiresInSeconds: 300 });
      const res = await upload(target, new Uint8Array(5_000));
      expect([400, 403]).toContain(res.status);
      expect(await driver.head(key)).toBeNull();
    });

    it("rejects a different content type, and stores nothing", async () => {
      const key = keyFor(ORG_A, "png");
      const target = await driver.createUpload({ key, contentType: "image/png", contentLength: png.byteLength, expiresInSeconds: 300 });
      const res = await upload(target, png, { "content-type": "text/html" });
      expect([400, 403]).toContain(res.status);
      expect(await driver.head(key)).toBeNull();
    });

    it("rejects a tampered signature and a target reused for another key", async () => {
      const key = keyFor(ORG_A, "png");
      const other = keyFor(ORG_B, "png");
      const target = await driver.createUpload({ key, contentType: "image/png", contentLength: png.byteLength, expiresInSeconds: 300 });
      const tampered = target.url.replace(/(signature|X-Amz-Signature)=([0-9a-f]{4})/i, "$1=0000");
      expect((await upload(target, png, target.headers, tampered)).status).toBe(403);
      expect((await upload(target, png, target.headers, target.url.replace(key, other))).status).toBe(403);
      expect(await driver.head(key)).toBeNull();
      expect(await driver.head(other)).toBeNull();
    });
  });

  describe("tenant scope with this driver", () => {
    it("organization A cannot read, overwrite or delete organization B's object, even with B's key", async () => {
      setStorageDriverForTests(driver);
      const bKey = keyFor(ORG_B);
      await storageFor({ organizationId: ORG_B }).put(bKey, bytes("B's file"), { contentType: "text/plain" });

      const asA = storageFor({ organizationId: ORG_A });
      const denied = code("PermissionDenied");
      await expect(asA.get(bKey)).rejects.toEqual(denied);
      await expect(asA.head(bKey)).rejects.toEqual(denied);
      await expect(asA.readRange(bKey, 0, 3)).rejects.toEqual(denied);
      await expect(asA.delete(bKey)).rejects.toEqual(denied);
      await expect(asA.put(bKey, bytes("mine now"), { contentType: "text/plain" })).rejects.toEqual(denied);
      await expect(asA.createUpload({ key: bKey, contentType: "text/plain", contentLength: 1, expiresInSeconds: 60 })).rejects.toEqual(denied);

      setStorageDriverForTests(driver);
      const stillThere = await storageFor({ organizationId: ORG_B }).get(bKey);
      expect(new TextDecoder().decode(await drain(stillThere.body))).toBe("B's file");
    });
  });
});

describe("provider failures become storage errors", () => {
  it("S3: wrong credentials → PermissionDenied, without leaking the secret", async () => {
    const wrongSecret = "definitely-not-the-secret-0123456789";
    const driver = new S3StorageDriver({ ...s3Config, secretAccessKey: wrongSecret, publicBaseUrl });
    const errors = await Promise.all([
      driver.put(keyFor(), bytes("x"), { contentType: "text/plain" }).catch((e) => e),
      driver.get(keyFor()).catch((e) => e),
      driver.head(keyFor()).catch((e) => e),
      driver.delete(keyFor()).catch((e) => e),
    ]);
    for (const error of errors) {
      expect(error).toEqual(code("PermissionDenied"));
      const serialized = `${error.message} ${JSON.stringify(error)} ${error.stack}`;
      expect(serialized).not.toContain(wrongSecret);
      expect(serialized).not.toContain(s3Config.accessKeyId + ":");
    }
  });

  it("S3: an unreachable endpoint → Unavailable", async () => {
    const driver = new S3StorageDriver({ ...s3Config, endpoint: "http://127.0.0.1:9", publicBaseUrl });
    await expect(driver.head(keyFor())).rejects.toEqual(code("Unavailable"));
    await expect(driver.put(keyFor(), bytes("x"), { contentType: "text/plain" })).rejects.toEqual(code("Unavailable"));
  });

  it("S3: a missing bucket → ConfigurationError on write", async () => {
    const driver = new S3StorageDriver({ ...s3Config, bucket: `forge-missing-${uuidv7()}`, publicBaseUrl });
    await expect(driver.put(keyFor(), bytes("x"), { contentType: "text/plain" })).rejects.toEqual(code("ConfigurationError"));
  });

  it("local: an unwritable directory → UploadFailed", async () => {
    const file = path.join(await tempDir(), "not-a-directory");
    await writeFile(file, "x");
    const driver = new LocalStorageDriver({ root: file, appOrigin: () => APP, publicBaseUrl });
    await expect(driver.put(keyFor(), bytes("x"), { contentType: "text/plain" })).rejects.toEqual(code("UploadFailed"));
  });
});

describe("configuration", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setStorageDriverForTests(null);
  });

  it("works with no storage credentials: the local driver, on disk", async () => {
    for (const name of Object.keys(process.env)) if (name.startsWith("STORAGE_")) delete process.env[name];
    process.env.STORAGE_LOCAL_DIR = await tempDir();
    const { resetEnvCache } = await import("@/platform/config/env");
    resetEnvCache();
    expect(getStorageDriver().name).toBe("local");
    const key = keyFor();
    const storage = storageFor({ organizationId: ORG_A });
    await storage.put(key, bytes("no account needed"), { contentType: "text/plain" });
    expect((await storage.head(key))?.size).toBe(17);
    resetEnvCache();
  });

  it("on Vercel without S3 settings, using storage fails with a configuration error; importing it never does", async () => {
    for (const name of Object.keys(process.env)) if (name.startsWith("STORAGE_")) delete process.env[name];
    process.env.VERCEL_ENV = "production";
    const { resetEnvCache } = await import("@/platform/config/env");
    resetEnvCache();
    await expect(import("@/platform/storage")).resolves.toBeDefined();
    await expect(storageFor({ organizationId: ORG_A }).head(keyFor())).rejects.toEqual(code("ConfigurationError"));
    resetEnvCache();
  });
});

describe("storage scope and RLS agree", () => {
  it("another organization's media is invisible in the database and unreachable in storage", async () => {
    const [A, B] = await Promise.all([createTenantGraph(), createTenantGraph()]);
    const driver = new LocalStorageDriver({ root: await tempDir(), appOrigin: () => APP, publicBaseUrl });
    setStorageDriverForTests(driver);
    try {
      // B's media row (from the fixture) and its object.
      await platformStorage().put(B.media.storageKey, bytes("B's original"), { contentType: "image/jpeg" });

      // As A: the row can't be found (RLS)…
      const rows = await withTenant({ orgId: A.org.id }, (tx) => tx.select().from(mediaAssets).where(eq(mediaAssets.id, B.media.id)));
      expect(rows).toEqual([]);
      // …and knowing the key anyway doesn't help (storage scope).
      const asA = storageFor({ organizationId: A.org.id, siteId: A.site.id });
      await expect(asA.get(B.media.storageKey)).rejects.toEqual(code("PermissionDenied"));
      await expect(asA.delete(B.media.storageKey)).rejects.toEqual(code("PermissionDenied"));

      // B itself reads its row and its object.
      const own = await withTenant({ orgId: B.org.id }, (tx) => tx.select().from(mediaAssets).where(eq(mediaAssets.id, B.media.id)));
      expect(own).toHaveLength(1);
      const object = await storageFor({ organizationId: B.org.id, siteId: B.site.id }).get(own[0]!.storageKey);
      expect(new TextDecoder().decode(await drain(object.body))).toBe("B's original");
    } finally {
      setStorageDriverForTests(null);
    }
  });
});
