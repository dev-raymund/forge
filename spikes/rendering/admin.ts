import "server-only";
import { desc, eq } from "drizzle-orm";
import { domains } from "@/modules/domains/schema";
import { withPlatform } from "@/platform/db/tenant";

/** Spike-only admin read: every active subdomain (no auth yet; the page 404s on production). */
export async function listSpikeSites() {
  return withPlatform((tx) =>
    tx
      .select({ host: domains.hostname, siteId: domains.siteId, orgId: domains.organizationId })
      .from(domains)
      .where(eq(domains.kind, "subdomain"))
      .orderBy(desc(domains.createdAt))
      .limit(50),
  );
}
