import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { entryDrafts } from "@/modules/content/schema";
import { withTenant } from "@/platform/db/tenant";
import type { SaveResult } from "./autosave";
import { canonicalJson, parseDocument } from "./document";

/**
 * Server side of autosave (plan §6.3, §7): one conditional UPDATE. The row is
 * written only if its version is still the one the client started from, so
 * two tabs can never silently overwrite each other. Autosave never creates a
 * revision; "Save" and "Publish" do (M5).
 */
export async function saveDraft(
  ctx: { orgId: string; userId: string },
  entryId: string,
  expectedVersion: number,
  content: unknown,
): Promise<SaveResult | { ok: false; reason: "not_found" }> {
  const parsed = parseDocument(content);
  if (!parsed.ok) return { ok: false, reason: "invalid", issues: parsed.issues ?? [parsed.error] };
  const hash = createHash("sha256").update(canonicalJson(parsed.document)).digest("hex");

  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .update(entryDrafts)
      .set({
        content: parsed.document,
        contentHash: hash,
        version: sql`${entryDrafts.version} + 1`,
        updatedBy: ctx.userId,
      })
      .where(and(eq(entryDrafts.entryId, entryId), eq(entryDrafts.version, expectedVersion)))
      .returning({ version: entryDrafts.version });
    if (row) return { ok: true, version: row.version };

    const [current] = await tx
      .select({ version: entryDrafts.version })
      .from(entryDrafts)
      .where(eq(entryDrafts.entryId, entryId));
    return current ? { ok: false, reason: "conflict", currentVersion: current.version } : { ok: false, reason: "not_found" };
  });
}
