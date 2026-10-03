import "server-only";
import { env, mediaPublicBaseUrl } from "@/platform/config/env";
import { storageConfig } from "./config";
import type { StorageDriver } from "./driver";
import { LocalStorageDriver } from "./providers/local";
import { S3StorageDriver } from "./providers/s3";

/**
 * The raw, unscoped driver. PRIVATE to platform/storage (lint-enforced), like
 * the raw database client: application code goes through `storageFor()` or
 * `platformStorage()` in ./scoped.ts.
 *
 * Built on first use, never at import; throws StorageError("ConfigurationError")
 * with an explanation when the selected driver can't be configured.
 */
let override: StorageDriver | null = null;
let cached: { key: string; driver: StorageDriver } | undefined;

export function getStorageDriver(): StorageDriver {
  if (override) return override;
  const config = storageConfig();
  const key = JSON.stringify({ ...config, secretAccessKey: undefined });
  if (cached?.key === key) return cached.driver;
  const publicBaseUrl = () => mediaPublicBaseUrl();
  const driver =
    config.driver === "local"
      ? new LocalStorageDriver({ root: config.root, appOrigin: () => env("core").APP_ORIGIN.replace(/\/$/, ""), publicBaseUrl })
      : new S3StorageDriver({ ...config, publicBaseUrl });
  cached = { key, driver };
  return driver;
}

/** Tests: use this driver; null restores configuration. */
export function setStorageDriverForTests(driver: StorageDriver | null) {
  override = driver;
  cached = undefined;
}
