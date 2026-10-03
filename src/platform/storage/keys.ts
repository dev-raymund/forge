import { StorageError } from "./errors";

/**
 * Object keys (plan §8). Keys are untrusted input until validated here, and
 * every driver call validates. The rules make traversal unrepresentable:
 * plain ASCII segments separated by single slashes, never starting with a
 * dot, never containing "..", "%", a backslash or a control character. Keys
 * are never URL-decoded.
 *
 * Tenant content lives under `o/{organizationId}/s/{siteId}/…`; the prefix is
 * what `storageFor()` enforces (./scoped.ts).
 */

export const MAX_KEY_LENGTH = 512;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isStorageKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  return key.split("/").every((segment) => SEGMENT.test(segment) && !segment.includes(".."));
}

export function assertStorageKey(key: unknown): asserts key is string {
  if (!isStorageKey(key)) throw new StorageError("InvalidKey", "Invalid storage key");
}

function assertUuid(value: string, what: string) {
  if (!UUID.test(value)) throw new StorageError("InvalidKey", `Invalid ${what} in storage key`);
}

/** `o/{organizationId}/` — everything an organization owns. */
export function organizationPrefix(organizationId: string): string {
  assertUuid(organizationId, "organization id");
  return `o/${organizationId}/`;
}

/** `o/{organizationId}/s/{siteId}/` — everything a site owns. */
export function sitePrefix(organizationId: string, siteId: string): string {
  assertUuid(siteId, "site id");
  return `${organizationPrefix(organizationId)}s/${siteId}/`;
}

export type MediaKeyParts = {
  organizationId: string;
  siteId: string;
  mediaId: string;
  /** Asset version, starting at 1. A new version gets new keys, so keys are immutable. */
  version: number;
  /** `original`, or a variant such as `w800` or `thumb`. */
  variant: string;
  /** Slugified file name without extension. */
  name: string;
  ext: string;
};

/** `o/{org}/s/{site}/m/{media}/v{n}/{variant}/{name}.{ext}` (plan §8). The ids come from trusted tenant context. */
export function mediaObjectKey(parts: MediaKeyParts): string {
  assertUuid(parts.mediaId, "media id");
  if (!Number.isInteger(parts.version) || parts.version < 1 || parts.version > 99_999) {
    throw new StorageError("InvalidKey", "Invalid version in storage key");
  }
  if (!/^[a-z0-9]{1,32}$/.test(parts.variant)) throw new StorageError("InvalidKey", "Invalid variant in storage key");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(parts.name) || parts.name.length > 100) {
    throw new StorageError("InvalidKey", "Invalid file name in storage key");
  }
  if (!/^[a-z0-9]{1,8}$/.test(parts.ext)) throw new StorageError("InvalidKey", "Invalid extension in storage key");
  const key = `${sitePrefix(parts.organizationId, parts.siteId)}m/${parts.mediaId}/v${parts.version}/${parts.variant}/${parts.name}.${parts.ext}`;
  assertStorageKey(key);
  return key;
}
