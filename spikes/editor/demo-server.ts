import type { SaveResult } from "./autosave";
import { parseDocument } from "./document";
import type { StoredDocument } from "./schema";

/**
 * In-memory stand-in for the saveDraft server action, for the manual spike
 * page only (the real one, spikes/editor/save-draft.ts, needs an entry and a
 * signed-in tenant, which arrive in M2–M5). Same contract: validate, then an
 * optimistic version check.
 */
export function createDemoServer(initial: StoredDocument) {
  const server = {
    version: 1,
    document: initial,
    async save(expectedVersion: number, doc: unknown): Promise<SaveResult> {
      await new Promise((r) => setTimeout(r, 150));
      const parsed = parseDocument({ v: 1, doc });
      if (!parsed.ok) return { ok: false, reason: "invalid", issues: parsed.issues ?? [parsed.error] };
      if (expectedVersion !== server.version) return { ok: false, reason: "conflict", currentVersion: server.version };
      server.document = parsed.document;
      server.version++;
      return { ok: true, version: server.version };
    },
    /** What another tab saving would do. */
    simulateOtherTab() {
      server.version++;
    },
  };
  return server;
}
