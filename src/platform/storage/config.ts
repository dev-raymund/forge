import "server-only";
import path from "node:path";
import { ConfigError, env, resolveStorageDriver } from "@/platform/config/env";
import { StorageError } from "./errors";

export type LocalStorageConfig = { driver: "local"; root: string };
export type S3StorageConfig = {
  driver: "s3";
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};
export type StorageConfig = LocalStorageConfig | S3StorageConfig;

/**
 * Resolved lazily, when storage is first used: importing the storage module
 * never fails on missing variables. Errors name the variables to set and never
 * include values.
 */
export function storageConfig(source: Record<string, string | undefined> = process.env): StorageConfig {
  let vars;
  try {
    vars = env("storage", source);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new StorageError(
        "ConfigurationError",
        `Storage is not configured: set ${err.variables.join(", ")}. The s3 driver (the default on Vercel) needs ` +
          "STORAGE_BUCKET, STORAGE_ENDPOINT, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY; " +
          "STORAGE_DRIVER=local stores files on disk instead (development only).",
      );
    }
    throw err;
  }
  if (resolveStorageDriver(vars) === "local") {
    // The directory holds development uploads, not application files: keep it out of the build's file tracing.
    return { driver: "local", root: path.resolve(/* turbopackIgnore: true */ vars.STORAGE_LOCAL_DIR ?? ".storage") };
  }
  return {
    driver: "s3",
    bucket: vars.STORAGE_BUCKET!,
    endpoint: vars.STORAGE_ENDPOINT!,
    region: vars.STORAGE_REGION,
    accessKeyId: vars.STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: vars.STORAGE_SECRET_ACCESS_KEY!,
    forcePathStyle: vars.STORAGE_FORCE_PATH_STYLE,
  };
}
