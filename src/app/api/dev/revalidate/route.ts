import { connection } from "next/server";
import { z } from "zod";
import { writeTagline } from "@spikes/rendering/queries";
import { invalidate } from "@/platform/cache";
import { notFound, problemResponse } from "@/platform/errors";
import { requestIdFrom } from "@/platform/observability";
import { hasBearerSecret } from "@/platform/security/bearer";

/**
 * Spike S1: the job-style path. A route handler can't use updateTag, so it
 * invalidates with revalidateTag(tag, { expire: 0 }) via invalidate(…, "background").
 * Local: open. Preview: needs the cron secret. Production: never.
 */
const input = z.object({ orgId: z.uuid(), siteId: z.uuid(), tagline: z.string().min(1).max(200) });

export async function POST(request: Request) {
  await connection();
  const requestId = requestIdFrom(request.headers);
  const vercelEnv = process.env.VERCEL_ENV;
  const allowed =
    vercelEnv !== "production" && (!vercelEnv || hasBearerSecret(request.headers, process.env.CRON_SECRET ?? ""));
  if (!allowed) return problemResponse(notFound(), requestId);

  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problemResponse(parsed.error, requestId);
  await writeTagline(parsed.data.orgId, parsed.data.siteId, parsed.data.tagline);
  const flushed = invalidate([{ type: "site.configChanged", siteId: parsed.data.siteId }], "background");
  return Response.json({ ok: true, flushed });
}
