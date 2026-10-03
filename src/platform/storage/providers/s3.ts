import "server-only";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { S3StorageConfig } from "../config";
import type { CreateUploadInput, ObjectInfo, PutOptions, StorageDriver, UploadTarget } from "../driver";
import { StorageError, type StorageErrorCode } from "../errors";
import { assertStorageKey } from "../keys";

/**
 * S3-compatible driver (D-18): Cloudflare R2 in production, RustFS in the
 * integration tests, any S3 API by configuration. This file is the only place
 * that imports the AWS SDK (lint-enforced).
 *
 * Nothing here is R2-specific. Checksums are sent only when an operation
 * requires them, because several S3-compatible stores reject the SDK's
 * newer default checksum headers.
 */

type SdkError = { name?: string; $metadata?: { httpStatusCode?: number }; code?: string };

/** Provider failure → our error. Only the short provider error name or status is kept. */
function translate(err: unknown, fallback: StorageErrorCode, action: string): StorageError {
  if (err instanceof StorageError) return err;
  const e = (err ?? {}) as SdkError;
  const status = e.$metadata?.httpStatusCode;
  const providerCode = e.name && e.name !== "Error" ? e.name : status ? String(status) : (e.code ?? "unknown");
  if (e.name === "NoSuchBucket") {
    return new StorageError("ConfigurationError", "Storage bucket does not exist (check STORAGE_BUCKET)", providerCode);
  }
  if (status === 404 || e.name === "NoSuchKey" || e.name === "NotFound") {
    return new StorageError("NotFound", "Object not found", providerCode);
  }
  if (status === 412 || e.name === "PreconditionFailed") {
    return new StorageError("AlreadyExists", "An object already exists at this key", providerCode);
  }
  if (status === 401 || status === 403) {
    return new StorageError("PermissionDenied", `Storage refused the ${action} (check the bucket and credentials)`, providerCode);
  }
  if (status === undefined || status >= 500 || status === 429) {
    // No HTTP status: the request never completed (DNS, connection refused, timeout).
    return new StorageError("Unavailable", `Storage is unavailable (${action})`, providerCode);
  }
  return new StorageError(fallback, `Storage ${action} failed`, providerCode);
}

export class S3StorageDriver implements StorageDriver {
  readonly name = "s3";
  private readonly client: S3Client;

  constructor(
    private readonly config: S3StorageConfig & { publicBaseUrl: () => string },
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        maxAttempts: 3,
      });
  }

  async put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    assertStorageKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          CacheControl: options.cacheControl,
          ContentDisposition: options.contentDisposition,
          IfNoneMatch: "*", // create only: keys are immutable
        }),
      );
    } catch (err) {
      throw translate(err, "UploadFailed", "upload");
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertStorageKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? "application/octet-stream" };
    } catch (err) {
      const error = translate(err, "Unavailable", "read");
      if (error.code === "NotFound") return null;
      throw error;
    }
  }

  async get(key: string) {
    assertStorageKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      if (!res.Body) throw new StorageError("Unavailable", "Storage returned no body");
      return {
        body: res.Body.transformToWebStream() as ReadableStream<Uint8Array>,
        info: { size: res.ContentLength ?? 0, contentType: res.ContentType ?? "application/octet-stream" },
      };
    } catch (err) {
      throw translate(err, "Unavailable", "read");
    }
  }

  async readRange(key: string, start: number, end: number): Promise<Uint8Array> {
    assertStorageKey(key);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new StorageError("InvalidKey", "Invalid byte range");
    }
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key, Range: `bytes=${start}-${end}` }),
      );
      return res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
    } catch (err) {
      const e = err as SdkError;
      // A range starting past the end of a (possibly empty) object: no bytes, not an error.
      if (e.$metadata?.httpStatusCode === 416) return new Uint8Array();
      throw translate(err, "Unavailable", "read");
    }
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
    } catch (err) {
      const error = translate(err, "DeleteFailed", "delete");
      if (error.code === "NotFound") return; // already gone
      throw error;
    }
  }

  async createUpload(input: CreateUploadInput): Promise<UploadTarget> {
    assertStorageKey(input.key);
    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.key,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
        }),
        // Both headers are part of the signature: another type or size is rejected by the store.
        { expiresIn: input.expiresInSeconds, signableHeaders: new Set(["content-type", "content-length"]) },
      );
      return {
        kind: "presigned-put",
        url,
        headers: { "content-type": input.contentType },
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    } catch (err) {
      throw translate(err, "UploadFailed", "upload signing");
    }
  }

  publicUrl(key: string): string {
    assertStorageKey(key);
    return `${this.config.publicBaseUrl()}/${key}`;
  }
}
