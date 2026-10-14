import { expect, test } from "@playwright/test";

/**
 * The storage seam through the real server, with no storage account (the local driver).
 *
 * M1-5's development route that issued upload targets for any caller is gone (M6-1): targets come only from
 * `requestUploads`, a Server Action that checks the session, the membership, `media.upload` and the storage
 * limit (tests/integration/media-uploads.test.ts runs the whole protocol against both drivers). What a browser
 * can reach without one is checked here: the local driver's upload route, which takes a PUT only with a valid
 * signature, and never for a malformed key. Deployments use the S3 driver, where this route answers 404.
 */

test.skip(!!process.env.E2E_BASE_URL, "the local storage route only exists with the local driver");

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const key = "o/00000000-0000-7000-8000-0000000000d0/s/00000000-0000-7000-8000-0000000000d1/m/00000000-0000-7000-8000-0000000000d2/v1/original/photo.png";
const signed = (signature: string) =>
  new URLSearchParams({ type: "image/png", size: String(png.byteLength), expires: String(Math.floor(Date.now() / 1000) + 600), signature });

test("the development route that issued upload targets without a session is gone", async ({ request }) => {
  expect((await request.post("/api/dev/storage", { data: { contentType: "image/png", size: png.byteLength } })).status()).toBe(404);
  expect((await request.get(`/api/dev/storage?key=${encodeURIComponent(key)}`)).status()).toBe(404);
});

test("the local upload route takes nothing without a valid signature", async ({ request }) => {
  const headers = { "content-type": "image/png", "if-none-match": "*" };
  expect((await request.put(`/api/storage/local/${key}?${signed("0".repeat(64))}`, { data: png, headers })).status()).toBe(403);
  expect((await request.put(`/api/storage/local/${key}`, { data: png, headers })).status()).toBe(403);
});

test("the local upload route refuses a malformed key, and a path that climbs out lands on no file it could write", async ({ request }) => {
  const headers = { "content-type": "image/png" };
  const statuses: Record<string, number> = {};
  for (const bad of ["o/a%5C..%5Cb/x.png", ".storage/.upload-secret", "o/x/%2e%2e%2f%2e%2e%2fsecret", "o/%2e%2e/secret.png"]) {
    statuses[bad] = (await request.put(`/api/storage/local/${bad}?${signed("0".repeat(64))}`, { data: png, headers })).status();
  }
  expect(statuses).toEqual({
    // Malformed keys: refused before any signature is checked or any file touched.
    "o/a%5C..%5Cb/x.png": 422,
    ".storage/.upload-secret": 422,
    "o/x/%2e%2e%2f%2e%2e%2fsecret": 422,
    // A dot segment is resolved by URL parsing before the app sees it (the key becomes `secret.png`); unsigned, refused.
    "o/%2e%2e/secret.png": 403,
  });
});
