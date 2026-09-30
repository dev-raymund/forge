"use server";

import { z } from "zod";
import { invalidate } from "@/platform/cache";
import { notFound } from "@/platform/errors";
import { writeTagline } from "./queries";

/**
 * Spike S1: "publish" from a Server Action → updateTag (read-your-writes).
 * No auth exists yet (M2), so this is refused on Vercel production, even when
 * its action id is called directly.
 */
const input = z.object({ orgId: z.uuid(), siteId: z.uuid(), tagline: z.string().min(1).max(200) });

export async function publishTaglineAction(formData: FormData) {
  if (process.env.VERCEL_ENV === "production") throw notFound();
  const { orgId, siteId, tagline } = input.parse(Object.fromEntries(formData));
  await writeTagline(orgId, siteId, tagline);
  invalidate([{ type: "site.configChanged", siteId }], "action");
}
