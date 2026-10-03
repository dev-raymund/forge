import { expect, test } from "@playwright/test";

/**
 * M1-5 through the real server, with no storage account: the app issues an
 * upload target, the client PUTs straight to it (the local driver's route
 * stands in for a presigned PUT), and the object is there. Deployments use
 * the S3 driver, where the browser talks to object storage directly.
 */

test.skip(!!process.env.E2E_BASE_URL, "the local storage route only exists with the local driver");

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test("direct upload round trip: issue a target, PUT the bytes, the object exists", async ({ request }) => {
  const issued = await (await request.post("/api/dev/storage", { data: { contentType: "image/png", size: png.byteLength } })).json();
  expect(issued.key).toMatch(/^o\/[0-9a-f-]{36}\/s\/[0-9a-f-]{36}\/m\/[0-9a-f-]{36}\/v1\/original\/upload\.png$/);
  expect(issued.upload).toMatchObject({ kind: "presigned-put", headers: { "content-type": "image/png" } });
  expect(issued.publicUrl).toMatch(new RegExp(`/media/${issued.key}$`));

  const put = await request.put(issued.upload.url, { data: png, headers: issued.upload.headers });
  expect(put.status()).toBe(200);
  const head = await (await request.get(`/api/dev/storage?key=${encodeURIComponent(issued.key)}`)).json();
  expect(head.object).toEqual({ size: png.byteLength, contentType: "image/png" });
});

test("the upload target accepts only the signed size, type and key", async ({ request }) => {
  const issued = await (await request.post("/api/dev/storage", { data: { contentType: "image/png", size: png.byteLength } })).json();
  const { url, headers } = issued.upload as { url: string; headers: Record<string, string> };

  expect((await request.put(url, { data: Buffer.alloc(4_096), headers })).status()).toBe(400);
  expect((await request.put(url, { data: png, headers: { "content-type": "text/html" } })).status()).toBe(400);
  expect((await request.put(url.replace(/signature=[0-9a-f]{4}/, "signature=0000"), { data: png, headers })).status()).toBe(403);
  expect((await request.put(url.replace("/original/upload.png", "/original/other.png"), { data: png, headers })).status()).toBe(403);

  const head = await (await request.get(`/api/dev/storage?key=${encodeURIComponent(issued.key)}`)).json();
  expect(head.object).toBeNull();
});

test("the scoped storage refuses keys outside its tenant and malformed keys", async ({ request }) => {
  const foreign = "o/00000000-0000-7000-8000-0000000000ff/s/00000000-0000-7000-8000-0000000000d1/x.png";
  expect((await request.get(`/api/dev/storage?key=${encodeURIComponent(foreign)}`)).status()).toBe(404);
  expect((await request.get(`/api/dev/storage?key=${encodeURIComponent("../../etc/passwd")}`)).status()).toBe(422);
});
