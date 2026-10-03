import "server-only";
import { problemResponse } from "@/platform/errors";
import { requestIdFrom } from "@/platform/observability/request-id";
import { isStorageError, StorageError, storageErrorToAppError } from "./errors";
import { getStorageDriver } from "./get-driver";
import { LocalStorageDriver } from "./providers/local";

/** Uploads through the local driver are for development; cap them like V1's largest file (25 MB PDF, plan §8). */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * `PUT /api/storage/local/{key}`: the local driver's stand-in for a presigned
 * PUT to object storage. It exists only while the local driver is active (a
 * 404 otherwise, including everywhere S3 is configured). Authorization is the
 * signature issued by `createUpload`, exactly as with S3.
 */
export async function handleLocalUpload(request: Request, key: string): Promise<Response> {
  const requestId = requestIdFrom(request.headers);
  try {
    const driver = getStorageDriver();
    if (!(driver instanceof LocalStorageDriver)) throw new StorageError("NotFound", "Not found");
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) throw new StorageError("UploadFailed", "Upload too large");
    const body = new Uint8Array(await request.arrayBuffer());
    await driver.receiveUpload(key, new URL(request.url).searchParams, request.headers.get("content-type"), body);
    return new Response(null, { status: 200 });
  } catch (err) {
    if (isStorageError(err, "UploadFailed")) {
      // A wrong size or type is the client's mistake, as S3 answers a signature mismatch.
      return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (isStorageError(err, "PermissionDenied")) return new Response(null, { status: 403 });
    return problemResponse(isStorageError(err) ? storageErrorToAppError(err) : err, requestId);
  }
}
