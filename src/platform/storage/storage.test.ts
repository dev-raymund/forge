import { describe, expect, it } from "vitest";
import { storageConfig } from "./config";
import type { StorageDriver } from "./driver";
import { StorageError, STORAGE_ERROR_CODES, storageErrorToAppError } from "./errors";
import { setStorageDriverForTests } from "./get-driver";
import { assertStorageKey, isStorageKey, mediaObjectKey, organizationPrefix, sitePrefix } from "./keys";
import { platformStorage, storageFor } from "./scoped";

const ORG_A = "0192f000-0000-7000-8000-00000000000a";
const ORG_B = "0192f000-0000-7000-8000-00000000000b";
const SITE_A = "0192f000-0000-7000-8000-0000000000a1";
const SITE_A2 = "0192f000-0000-7000-8000-0000000000a2";
const MEDIA = "0192f000-0000-7000-8000-0000000000e1";

describe("storage keys", () => {
  it("builds the media key layout from the plan", () => {
    const key = mediaObjectKey({ organizationId: ORG_A, siteId: SITE_A, mediaId: MEDIA, version: 1, variant: "w800", name: "team-photo", ext: "webp" });
    expect(key).toBe(`o/${ORG_A}/s/${SITE_A}/m/${MEDIA}/v1/w800/team-photo.webp`);
    expect(key.startsWith(sitePrefix(ORG_A, SITE_A))).toBe(true);
    expect(key.startsWith(organizationPrefix(ORG_A))).toBe(true);
  });

  it.each([
    ["an organization id that isn't a UUID", { organizationId: "../other" }],
    ["a site id with a slash", { siteId: `${SITE_A}/../x` }],
    ["a variant with a path", { variant: "../w800" }],
    ["a file name with dots", { name: "../../secret" }],
    ["an uppercase extension with a path", { ext: "webp/../x" }],
    ["version zero", { version: 0 }],
  ])("refuses %s in the key builder", (_name, override) => {
    const parts = { organizationId: ORG_A, siteId: SITE_A, mediaId: MEDIA, version: 1, variant: "original", name: "photo", ext: "jpg" };
    expect(() => mediaObjectKey({ ...parts, ...override })).toThrow(StorageError);
  });

  it.each([
    "../../secret",
    "../other-tenant/file",
    `o/${ORG_A}/../${ORG_B}/file.jpg`,
    `o/${ORG_A}/./file.jpg`,
    "/etc/passwd",
    "C:\\Windows\\system32",
    `o/${ORG_A}\\..\\x`,
    "%2e%2e%2fsecret",
    `o/${ORG_A}/%2e%2e/${ORG_B}/x`,
    "..%2f..%2fsecret",
    `o/${ORG_A}//double-slash`,
    `o/${ORG_A}/trailing/`,
    `o/${ORG_A}/.hidden`,
    `o/${ORG_A}/a..b`,
    "o/x/file\u0000.jpg",
    "o/x/file name.jpg",
    "o/x/ünïcode.jpg",
    "",
    "a".repeat(513),
  ])("rejects the key %j", (key) => {
    expect(isStorageKey(key)).toBe(false);
    expect(() => assertStorageKey(key)).toThrow(expect.objectContaining({ code: "InvalidKey" }));
  });

  it("rejects non-strings", () => {
    for (const value of [null, undefined, 42, {}, ["o", "x"]]) expect(isStorageKey(value)).toBe(false);
  });
});

/** An in-memory driver that records calls: enough to prove the scope guard runs before any provider. */
function fakeDriver() {
  const calls: string[] = [];
  const note = (op: string, key: string) => void calls.push(`${op} ${key}`);
  const driver: StorageDriver = {
    name: "local",
    put: async (key) => note("put", key),
    get: async (key) => {
      note("get", key);
      return { body: new ReadableStream(), info: { size: 0, contentType: "x/y" } };
    },
    head: async (key) => {
      note("head", key);
      return null;
    },
    readRange: async (key) => {
      note("readRange", key);
      return new Uint8Array();
    },
    delete: async (key) => note("delete", key),
    createUpload: async ({ key }) => {
      note("createUpload", key);
      return { kind: "presigned-put", url: "http://x", headers: {}, expiresAt: new Date() };
    },
    publicUrl: (key) => `https://cms.example.com/media/${key}`,
  };
  return { driver, calls };
}

describe("storageFor (tenant scope)", () => {
  const aKey = `o/${ORG_A}/s/${SITE_A}/m/${MEDIA}/v1/original/photo.jpg`;
  const bKey = `o/${ORG_B}/s/${SITE_A}/m/${MEDIA}/v1/original/photo.jpg`;
  const denied = expect.objectContaining({ code: "PermissionDenied" });

  it("lets a tenant use its own keys and refuses every operation on another tenant's key", async () => {
    const { driver, calls } = fakeDriver();
    setStorageDriverForTests(driver);
    try {
      const storage = storageFor({ organizationId: ORG_A });
      await storage.put(aKey, new Uint8Array([1]), { contentType: "image/jpeg" });
      await storage.head(aKey);
      expect(calls).toEqual([`put ${aKey}`, `head ${aKey}`]);

      await expect(storage.get(bKey)).rejects.toEqual(denied);
      await expect(storage.head(bKey)).rejects.toEqual(denied);
      await expect(storage.readRange(bKey, 0, 10)).rejects.toEqual(denied);
      await expect(storage.delete(bKey)).rejects.toEqual(denied);
      await expect(storage.put(bKey, new Uint8Array(), { contentType: "x/y" })).rejects.toEqual(denied);
      await expect(storage.createUpload({ key: bKey, contentType: "image/png", contentLength: 1, expiresInSeconds: 60 })).rejects.toEqual(denied);
      expect(() => storage.publicUrl(bKey)).toThrow(denied);
      expect(calls).toHaveLength(2); // the provider was never asked about B's object
    } finally {
      setStorageDriverForTests(null);
    }
  });

  it("can narrow to one site, and prefix look-alikes don't match", async () => {
    const { driver } = fakeDriver();
    setStorageDriverForTests(driver);
    try {
      const site = storageFor({ organizationId: ORG_A, siteId: SITE_A });
      await expect(site.head(aKey)).resolves.toBeNull();
      await expect(site.head(`o/${ORG_A}/s/${SITE_A2}/m/${MEDIA}/v1/original/photo.jpg`)).rejects.toEqual(denied);
      // "o/{A}x/…" starts with "o/{A}" as a string but is a different tenant prefix.
      await expect(storageFor({ organizationId: ORG_A }).head(`o/${ORG_A}x/file.jpg`)).rejects.toEqual(denied);
    } finally {
      setStorageDriverForTests(null);
    }
  });

  it("validates keys and scope ids before anything else", async () => {
    const { driver, calls } = fakeDriver();
    setStorageDriverForTests(driver);
    try {
      await expect(storageFor({ organizationId: ORG_A }).get(`o/${ORG_A}/../${ORG_B}/x`)).rejects.toMatchObject({ code: "InvalidKey" });
      expect(() => storageFor({ organizationId: "../" + ORG_B })).toThrow(expect.objectContaining({ code: "InvalidKey" }));
      await expect(platformStorage().head("../../etc/passwd")).rejects.toMatchObject({ code: "InvalidKey" });
      await expect(platformStorage().head(bKey)).resolves.toBeNull(); // platform scope crosses tenants by design
      expect(calls).toEqual([`head ${bKey}`]);
    } finally {
      setStorageDriverForTests(null);
    }
  });
});

describe("storage configuration", () => {
  it("needs no credentials locally: the local driver, in .storage", () => {
    expect(storageConfig({})).toMatchObject({ driver: "local" });
    expect((storageConfig({}) as { root: string }).root.endsWith(".storage")).toBe(true);
    expect(storageConfig({ STORAGE_LOCAL_DIR: "/tmp/forge-x" })).toEqual({ driver: "local", root: "/tmp/forge-x" });
  });

  it("uses S3 when configured, with R2-friendly defaults", () => {
    expect(
      storageConfig({
        STORAGE_DRIVER: "s3",
        STORAGE_BUCKET: "forge-media",
        STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
        STORAGE_ACCESS_KEY_ID: "id",
        STORAGE_SECRET_ACCESS_KEY: "secret",
      }),
    ).toEqual({
      driver: "s3",
      bucket: "forge-media",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      accessKeyId: "id",
      secretAccessKey: "secret",
      forcePathStyle: true,
    });
  });

  it("on Vercel, missing S3 settings are a clear configuration error (names, never values)", () => {
    const run = () => storageConfig({ VERCEL_ENV: "production", STORAGE_BUCKET: "b", STORAGE_SECRET_ACCESS_KEY: "s3cr3t-value" });
    expect(run).toThrow(expect.objectContaining({ code: "ConfigurationError" }));
    try {
      run();
    } catch (e) {
      expect((e as Error).message).toMatch(/STORAGE_ENDPOINT/);
      expect((e as Error).message).toMatch(/STORAGE_ACCESS_KEY_ID/);
      expect((e as Error).message).not.toContain("s3cr3t-value");
    }
  });
});

describe("storage errors", () => {
  it("map onto the application error model", () => {
    const kind = (code: (typeof STORAGE_ERROR_CODES)[number]) => storageErrorToAppError(new StorageError(code, "x")).kind;
    expect(kind("NotFound")).toBe("NotFound");
    expect(kind("PermissionDenied")).toBe("NotFound"); // another tenant's object looks like no object
    expect(kind("AlreadyExists")).toBe("Conflict");
    expect(kind("InvalidKey")).toBe("Validation");
    for (const code of ["Unavailable", "UploadFailed", "DeleteFailed", "ConfigurationError"] as const) expect(kind(code)).toBe("Unavailable");
    expect(STORAGE_ERROR_CODES).toHaveLength(8);
  });
});
