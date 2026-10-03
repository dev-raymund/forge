# ADR 0008: Storage behind a `StorageDriver`, with a local driver and an S3-compatible driver

| | |
|---|---|
| **Status** | Accepted for V1 |
| **Date** | 2026-10-03 |
| **Issue** | M1-5 (v1-github-issues.md) |
| **Decisions touched** | D-18 (storage abstraction), D-17 (direct uploads); builds on ADR 0006 (media at `/media`) |

## Context

D-18 defines a `StorageDriver` so object storage is replaceable. The V1 plan shipped only the S3-compatible driver (R2 in production, an S3 container locally). Development must now work with **no storage account and no credentials**, so V1 has two drivers behind the same contract.

## Decision

```text
module (trusted tenant context)
    ↓ storageFor({ organizationId, siteId? })      tenant-scoped; or platformStorage() for platform work
StorageDriver
    ├── LocalStorageDriver   filesystem, development and tests
    └── S3StorageDriver      any S3 API: Cloudflare R2 in production, RustFS in tests
```

1. **The interface** (`src/platform/storage/driver.ts`) has exactly what V1 media needs:

   | Operation | Used by |
   |---|---|
   | `createUpload({ key, contentType, contentLength, expiresInSeconds })` → a `presigned-put` target | `requestUploads` (browser uploads straight to storage) |
   | `head(key)` → `{ size, contentType }` or `null` | `completeUpload` (declared size); also the existence check |
   | `readRange(key, start, end)` | `completeUpload` (magic-byte sniff) |
   | `put(key, bytes, { contentType, cacheControl?, contentDisposition? })` | Server-written objects (image variants) |
   | `get(key)` → stream + info | The `/media/{key}` route |
   | `delete(key)` (idempotent) | Failed uploads, trash purge |
   | `publicUrl(key)` | URLs in rendered content |

   Evaluated and left out until something needs them:
   - `exists`: `head` covers it.
   - `createDownloadUrl` / signed GET: V1 media is public through `/media`; private files are post-V1.
   - `deletePrefix`: tenant purge is post-V1.
2. **Keys are immutable.** `put` never overwrites; it throws `AlreadyExists` (S3 `If-None-Match: *`, an atomic create on disk). A new asset version gets new keys, so `/media` responses can be cached forever.
3. **Key layout** (plan §8): `o/{organizationId}/s/{siteId}/m/{mediaId}/v{n}/{variant}/{name}.{ext}`, built by `mediaObjectKey()` from ids that come from trusted tenant context.
4. **Keys are untrusted input.** Every driver call validates:
   - plain ASCII segments separated by single slashes;
   - a segment never starts with a dot and never contains `..`, `%`, a backslash, a space or a control character;
   - at most 512 characters; keys are never URL-decoded.

   Traversal is therefore unrepresentable. The local driver also checks the resolved path stays inside its root.
5. **Tenant boundary.** `storageFor({ organizationId, siteId? })` restricts every operation to the tenant's prefix (`o/{org}/` or `o/{org}/s/{site}/`).
   - A key outside it is `PermissionDenied` **before any provider is contacted**, whatever key the caller supplied.
   - It is the storage counterpart of `withTenant()`: rows are protected by RLS, objects by this prefix check.
   - `platformStorage()` is the counterpart of `withPlatform()`, for work that legitimately crosses tenants (serving public media by key, purge jobs).
   - The raw driver and the providers are private to `platform/` (ESLint).
6. **Local driver** (`providers/local.ts`), for development and tests.
   - Files live under `STORAGE_LOCAL_DIR` (default `.storage/`, gitignored): `objects/{key}` plus a JSON sidecar `meta/{key}.json`.
   - It mirrors S3's behaviour, so media code has one path.
   - `createUpload` returns an HMAC-signed URL on the app itself, `/api/storage/local/{key}`. The route accepts the PUT only if the signature is valid and unexpired and the content type and length are exactly the signed ones.
   - That route answers 404 unless the local driver is active.
7. **S3 driver** (`providers/s3.ts`): the only file that imports the AWS SDK (ESLint).
   - It is configured by endpoint, region, bucket and credentials. Nothing is R2-specific; R2 is `STORAGE_REGION=auto` and its endpoint.
   - Path-style addressing by default.
   - Checksums only when required (several S3-compatible stores reject the SDK's newer default checksum headers).
   - Presigned PUTs **sign `Content-Type` and `Content-Length`**, so the store itself rejects another type or size.
8. **Public URLs are separate from storage.** `publicUrl(key)` = `MEDIA_PUBLIC_BASE_URL` + key, defaulting to `${APP_ORIGIN}/media` (ADR 0006). Neither the database nor callers ever see a bucket URL; a CDN domain later is a configuration change.
9. **Errors.** One `StorageError` with a `code`: `NotFound`, `AlreadyExists`, `InvalidKey`, `PermissionDenied`, `Unavailable`, `UploadFailed`, `DeleteFailed`, `ConfigurationError`.
   - Messages are ours; only the provider's short error name or status is kept (`providerCode`), never its response, a signed URL or credentials.
   - `storageErrorToAppError()` maps them to the application model. `PermissionDenied` becomes `NotFound`, like any other cross-tenant access.
10. **Configuration** is lazy and validated (`env("storage")`); importing the storage module never fails.
    - The driver is `STORAGE_DRIVER`, defaulting to `s3` on Vercel (its filesystem isn't durable) and `local` elsewhere.
    - Missing S3 settings surface on first use as `ConfigurationError`, naming the variables. Readiness reports the `storage` group.
11. **The storage layer knows bytes, keys, content type and size.** Type allow-lists, size limits, dimensions, variants, folders and media records belong to the media module (M6).

## Evidence

- `src/platform/storage/storage.test.ts` (34 unit tests):
  - key builder and validation, including `../../secret`, `../other-tenant/file`, absolute paths, encoded traversal, backslashes, NUL, double slashes;
  - the scope guard with a fake driver (the provider is never called for another tenant's key);
  - configuration and error mapping.
- `tests/integration/storage.test.ts` (45 tests): **the same contract against both drivers**, the local filesystem and S3 on the RustFS container.
  - put/get/head/readRange/delete; content type and size preserved; no overwrite; missing objects; invalid keys on every operation.
  - Direct upload round trip, with wrong size, wrong type, tampered signature and reuse for another key all rejected.
  - Tenant isolation with the real drivers.
  - Provider failures: wrong credentials → `PermissionDenied` without leaking the secret; unreachable endpoint → `Unavailable`; missing bucket → `ConfigurationError`; unwritable directory → `UploadFailed`.
  - Zero-credential local use; a configuration error on Vercel without settings.
  - Storage scope agreeing with RLS on a real `media_assets` row.
- `tests/unit/lint-boundaries.test.ts`: the S3 SDK only in `providers/`; the raw driver private to `platform/`.
- `tests/e2e/storage.spec.ts` (3 tests): the upload round trip and its rejections through the real server with the local driver.

Mutation checks:
- Removing the prefix guard fails the isolation tests.
- Removing the signed headers fails the content-type rejection.

The contract suite also found and fixed two driver bugs: an invalid key reported as "unavailable" by the local `readRange`, and a missing bucket reported as a missing object.

## Consequences

- CI needs no cloud account: the S3 side runs against RustFS in docker-compose (now with a health check).
- The local driver is for development only. On Vercel the default is S3, and missing settings are reported instead of silently writing to an ephemeral disk.
- Real Cloudflare R2 has not been exercised yet (no account). R2's S3 API supports everything used here: conditional puts, range reads, and presigned PUTs with signed headers. The first deployment should run the contract suite against a test bucket there:
  `TEST_S3_ENDPOINT=… TEST_S3_BUCKET=… TEST_S3_ACCESS_KEY_ID=… TEST_S3_SECRET_ACCESS_KEY=… npm run test:integration -- tests/integration/storage.test.ts`.
