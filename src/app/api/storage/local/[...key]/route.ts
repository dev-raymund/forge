import { handleLocalUpload } from "@/platform/storage";

/**
 * Development only: the local storage driver's upload target (ADR 0008).
 * With the S3 driver, browsers upload straight to object storage and this
 * route answers 404.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  return handleLocalUpload(request, key.join("/"));
}
