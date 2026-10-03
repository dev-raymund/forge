import "server-only";
import type { CreateUploadInput, PutOptions, StorageDriver } from "./driver";
import { StorageError } from "./errors";
import { getStorageDriver } from "./get-driver";
import { assertStorageKey, organizationPrefix, sitePrefix } from "./keys";

/**
 * Tenant-scoped storage: the storage counterpart of `withTenant()` (ADR 0008).
 *
 * `storageFor({ organizationId, siteId? })` returns the driver's operations
 * restricted to that tenant's key prefix. The ids come from trusted tenant
 * context (the same one passed to withTenant), never from request input, so a
 * key from another organization is refused here whatever the caller supplied,
 * before any provider is contacted. Database rows are protected by RLS;
 * objects are protected by this prefix check.
 */
export type StorageScope = { organizationId: string; siteId?: string };

function guard(driver: () => StorageDriver, check: (key: string) => void): StorageDriver {
  const checked = <T>(key: string, run: (d: StorageDriver) => T): T => {
    assertStorageKey(key);
    check(key);
    return run(driver());
  };
  return {
    get name() {
      return driver().name;
    },
    put: async (key, body: Uint8Array, options: PutOptions) => checked(key, (d) => d.put(key, body, options)),
    get: async (key) => checked(key, (d) => d.get(key)),
    head: async (key) => checked(key, (d) => d.head(key)),
    readRange: async (key, start, end) => checked(key, (d) => d.readRange(key, start, end)),
    delete: async (key) => checked(key, (d) => d.delete(key)),
    createUpload: async (input: CreateUploadInput) => checked(input.key, (d) => d.createUpload(input)),
    publicUrl: (key) => checked(key, (d) => d.publicUrl(key)),
  };
}

export function storageFor(scope: StorageScope): StorageDriver {
  // Building the prefix validates the ids; a malformed id is an InvalidKey, not a wider scope.
  const prefix = scope.siteId ? sitePrefix(scope.organizationId, scope.siteId) : organizationPrefix(scope.organizationId);
  return guard(getStorageDriver, (key) => {
    if (!key.startsWith(prefix)) throw new StorageError("PermissionDenied", "Storage key is outside this tenant");
  });
}

/**
 * Unscoped access for platform work that legitimately crosses tenants: serving
 * public media by key, purge jobs. The counterpart of `withPlatform()`. Keys
 * are still validated. Never call this with a key taken from a tenant request.
 */
export function platformStorage(): StorageDriver {
  return guard(getStorageDriver, () => undefined);
}
