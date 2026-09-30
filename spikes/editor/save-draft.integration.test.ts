import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { entryDrafts } from "@/modules/content/schema";
import { withTenant } from "@/platform/db/tenant";
import { createTenantGraph } from "../../tests/fixtures/factories";
import { sampleDocument } from "./fixtures";
import { saveDraft } from "./save-draft";

/** The server half of autosave against Postgres through the pooler, as forge_app with RLS. */

type Graph = Awaited<ReturnType<typeof createTenantGraph>>;
let A: Graph;
let B: Graph;
const ctx = (g: Graph) => ({ orgId: g.org.id, userId: g.user.id });

async function draftVersion(g: Graph) {
  const [row] = await withTenant(ctx(g), (tx) =>
    tx.select({ version: entryDrafts.version, content: entryDrafts.content, hash: entryDrafts.contentHash })
      .from(entryDrafts).where(eq(entryDrafts.entryId, g.entry.id)),
  );
  return row!;
}

beforeAll(async () => {
  [A, B] = await Promise.all([createTenantGraph(), createTenantGraph()]);
});

describe("saveDraft (optimistic concurrency)", () => {
  it("writes the validated document and bumps the version", async () => {
    const { version } = await draftVersion(A);
    const result = await saveDraft(ctx(A), A.entry.id, version, sampleDocument);
    expect(result).toEqual({ ok: true, version: version + 1 });
    const row = await draftVersion(A);
    expect(row.content).toEqual(sampleDocument);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a stale version is a conflict and changes nothing", async () => {
    const before = await draftVersion(A);
    const result = await saveDraft(ctx(A), A.entry.id, before.version - 1, sampleDocument);
    expect(result).toEqual({ ok: false, reason: "conflict", currentVersion: before.version });
    expect(await draftVersion(A)).toEqual(before);
  });

  it("two tabs saving from the same version: exactly one wins", async () => {
    const { version } = await draftVersion(A);
    const results = await Promise.all([
      saveDraft(ctx(A), A.entry.id, version, sampleDocument),
      saveDraft(ctx(A), A.entry.id, version, sampleDocument),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "conflict", currentVersion: version + 1 }]);
  });

  it("rejects invalid documents before touching the database", async () => {
    const before = await draftVersion(A);
    const hostile = { v: 1, doc: { type: "doc", content: [{ type: "html", attrs: { html: "<script>" } }] } };
    const result = await saveDraft(ctx(A), A.entry.id, before.version, hostile);
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(await draftVersion(A)).toEqual(before);
  });

  it("another organization's entry is simply not found (RLS)", async () => {
    const result = await saveDraft(ctx(B), A.entry.id, 1, sampleDocument);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
