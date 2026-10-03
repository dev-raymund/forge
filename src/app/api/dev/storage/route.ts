import { connection } from "next/server";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { notFound, problemResponse } from "@/platform/errors";
import { requestIdFrom } from "@/platform/observability";
import { hasBearerSecret } from "@/platform/security/bearer";
import { isStorageError, mediaObjectKey, storageErrorToAppError, storageFor } from "@/platform/storage";

/**
 * Dev/E2E only (M1-5): exercises the storage seam the way media uploads will
 * (M6): POST issues a scoped upload target, GET reports what was stored. The
 * tenant here is a fixed development scope; real requests take it from the
 * signed-in tenant context. Local: open. Preview: needs the cron secret.
 * Production: never.
 */
const DEV_SCOPE = { organizationId: "00000000-0000-7000-8000-0000000000d0", siteId: "00000000-0000-7000-8000-0000000000d1" };
const input = z.object({ contentType: z.enum(["image/png", "image/jpeg", "image/webp", "application/pdf"]), size: z.int().min(1).max(25 * 1024 * 1024) });
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/pdf": "pdf" };

function allowed(request: Request) {
  const vercelEnv = process.env.VERCEL_ENV;
  return vercelEnv !== "production" && (!vercelEnv || hasBearerSecret(request.headers, process.env.CRON_SECRET ?? ""));
}

export async function POST(request: Request) {
  await connection();
  const requestId = requestIdFrom(request.headers);
  if (!allowed(request)) return problemResponse(notFound(), requestId);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problemResponse(parsed.error, requestId);
  try {
    const key = mediaObjectKey({ ...DEV_SCOPE, mediaId: uuidv7(), version: 1, variant: "original", name: "upload", ext: EXT[parsed.data.contentType]! });
    const storage = storageFor(DEV_SCOPE);
    const upload = await storage.createUpload({ key, contentType: parsed.data.contentType, contentLength: parsed.data.size, expiresInSeconds: 600 });
    return Response.json({ key, upload, publicUrl: storage.publicUrl(key) });
  } catch (err) {
    return problemResponse(isStorageError(err) ? storageErrorToAppError(err) : err, requestId);
  }
}

export async function GET(request: Request) {
  await connection();
  const requestId = requestIdFrom(request.headers);
  if (!allowed(request)) return problemResponse(notFound(), requestId);
  try {
    const key = new URL(request.url).searchParams.get("key") ?? "";
    return Response.json({ object: await storageFor(DEV_SCOPE).head(key) });
  } catch (err) {
    return problemResponse(isStorageError(err) ? storageErrorToAppError(err) : err, requestId);
  }
}
