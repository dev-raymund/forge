import { connection } from "next/server";
import { deliverableObject } from "@/modules/media";
import { requestIdFrom, reportError } from "@/platform/observability";
import { isStorageError } from "@/platform/storage";

/**
 * V1 media delivery (M6-2; plan §8, ADR 0006): `/media/{key}` streams an object from storage, but only one that an
 * authoritative record says is public now (`deliverableObject`: a ready, untrashed item's variant or document, or a
 * user's current avatar). Anything else, any key of another shape included, is one answer: 404.
 *
 * Keys are immutable, so a served object is cached for a year by browsers and the CDN. A 404 is never cached: an
 * upload being processed answers 404 until it is ready, then the same URL serves it. Every response refuses to be
 * sniffed, scripted or framed (`nosniff`; `default-src 'none'; sandbox`). The proxy strips cookies and credentials
 * before this runs, and never adds any.
 */

const SECURITY = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } as const;
const IMMUTABLE = "public, max-age=31536000, immutable";

const answer = (status: 404 | 503, text: string) =>
  new Response(text, { status, headers: { ...SECURITY, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function GET(request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  await connection();
  const requestId = requestIdFrom(request.headers);
  const { key: segments } = await params;
  // One spelling per object: a segment that decodes to a separator (`%2F`, `%5C`) is not a way to name a key.
  if (segments.some((segment) => /[/\\]/.test(segment))) return answer(404, "Not found");
  const key = segments.join("/");
  try {
    const object = await deliverableObject(key);
    if (!object) return answer(404, "Not found");
    const { body, info } = await object.storage.get(key);
    return new Response(body, {
      headers: {
        ...SECURITY,
        // The record's type, from the allow-list: never the request's, never what the stored object claims.
        "content-type": object.contentType,
        "content-length": String(info.size),
        "content-disposition": `${object.disposition}; filename="${object.filename}"`,
        "cache-control": IMMUTABLE,
        // For CDNs that cache only on their own header (Vercel's among them); browsers ignore it.
        "cdn-cache-control": IMMUTABLE,
      },
    });
  } catch (error) {
    // A ready record whose object is gone: not found (and reported, it should not happen). Storage down: unavailable.
    if (isStorageError(error, "NotFound")) {
      reportError(error, { module: "media", requestId }, { phase: "deliver" });
      return answer(404, "Not found");
    }
    reportError(error, { module: "media", requestId }, { phase: "deliver" });
    return answer(503, "Temporarily unavailable");
  }
}
