import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Publishing (M4-5, ADR 0015): the transition table, the request's schema,
 * and the order the service does things in, with the database replaced. The
 * same service on real Postgres, with real roles, RLS and audit rows, is
 * tests/integration/publishing.test.ts.
 */
const db = vi.hoisted(() => ({
  status: "coming_soon" as string | null,
  calls: [] as string[],
  permissionDenied: false,
}));

vi.mock("@/modules/tenancy", () => ({
  requirePermission: (_ctx: unknown, permission: string) => {
    db.calls.push(`permission:${permission}`);
    if (db.permissionDenied) throw Object.assign(new Error("Forbidden"), { code: "forbidden" });
  },
  inTenant: async (_ctx: unknown, work: (tx: object) => unknown) => {
    db.calls.push("transaction");
    return work({});
  },
}));
vi.mock("@/modules/audit", () => ({
  record: async (_tx: unknown, event: { action: string; metadata: unknown }) => {
    db.calls.push(`record:${event.action}:${JSON.stringify(event.metadata)}`);
  },
}));
vi.mock("./repository", () => ({
  lockSiteStatus: async () => {
    db.calls.push("lock");
    return db.status;
  },
  findSiteRow: async () => ({ id: "site-1", slug: "bakery", name: "Bakery", status: db.status, address: "acme-bakery" }),
  updateSiteStatus: async (_tx: unknown, _org: string, _site: string, status: string) => {
    db.calls.push(`update:${status}`);
  },
}));

import { tagsForAll } from "@/platform/cache";
import { isAppError } from "@/platform/errors";
import { SETTABLE_STATUSES, statusTransition } from "./publishing";
import { setSiteStatus } from "./publishing.service";
import { setSiteStatusSchema } from "./validation";

type Ctx = Parameters<typeof setSiteStatus>[0];
const ctxFor = (emailVerified: boolean) => ({ org: { id: "org-1", slug: "acme" }, site: { id: "site-1", slug: "bakery" }, actor: { userId: "u-1", emailVerified } }) as unknown as Ctx;

beforeEach(() => {
  db.status = "coming_soon";
  db.calls = [];
  db.permissionDenied = false;
});

describe("which status changes a member may make", () => {
  it("coming soon ↔ live; the same status is nothing to do; a suspended or unknown status is refused", () => {
    expect(statusTransition("coming_soon", "live")).toBe("change");
    expect(statusTransition("live", "coming_soon")).toBe("change");
    expect(statusTransition("live", "live")).toBe("unchanged");
    expect(statusTransition("coming_soon", "coming_soon")).toBe("unchanged");
    for (const target of SETTABLE_STATUSES) {
      expect(statusTransition("suspended", target), target).toBe("refused");
      expect(statusTransition("draft", target), target).toBe("refused");
      expect(statusTransition("", target), target).toBe("refused");
    }
  });

  it("the request names coming_soon or live, nothing else", () => {
    expect(setSiteStatusSchema.parse({ status: "live" })).toEqual({ status: "live" });
    expect(setSiteStatusSchema.parse({ status: "coming_soon" })).toEqual({ status: "coming_soon" });
    for (const status of ["suspended", "LIVE", "published", "", " live", null, undefined, ["live"]]) {
      expect(setSiteStatusSchema.safeParse({ status }).success, String(status)).toBe(false);
    }
  });
});

describe("setSiteStatus, in order", () => {
  it("asks for site.settings.manage before anything else, and stops there when it is not held", async () => {
    db.permissionDenied = true;
    await expect(setSiteStatus(ctxFor(true), { status: "live" })).rejects.toThrow("Forbidden");
    expect(db.calls).toEqual(["permission:site.settings.manage"]);
  });

  it("publishing needs a verified email address: refused before the database is touched", async () => {
    const refusal = await setSiteStatus(ctxFor(false), { status: "live" }).catch((error: unknown) => error);
    expect(isAppError(refusal) && refusal.kind).toBe("Forbidden");
    expect((refusal as Error).message).toBe("Verify your email address to publish this site.");
    expect(db.calls).toEqual(["permission:site.settings.manage"]);
  });

  it("an unknown or suspended status is refused before the database is touched", async () => {
    const refusal = await setSiteStatus(ctxFor(true), { status: "suspended" }).catch((error: unknown) => error);
    expect(isAppError(refusal) && refusal.kind).toBe("Validation");
    expect(db.calls).toEqual(["permission:site.settings.manage"]);
  });

  it("publishing: lock, check, write, record, then the site's cache tag", async () => {
    const result = await setSiteStatus(ctxFor(true), { status: "live" });
    expect(db.calls).toEqual([
      "permission:site.settings.manage",
      "transaction",
      "lock",
      "update:live",
      'record:site.status_changed:{"name":"Bakery","previousStatus":"coming_soon","newStatus":"live"}',
    ]);
    expect(result.changed).toBe(true);
    expect(result.site.status).toBe("live");
    expect(result.events).toEqual([{ type: "site.statusChanged", siteId: "site-1" }]);
    expect(tagsForAll(result.events)).toEqual({ immediate: ["site:site-1"], stale: [] });
  });

  it("back to Coming soon needs no verified address (it hides the site), and is recorded the same way", async () => {
    db.status = "live";
    const result = await setSiteStatus(ctxFor(false), { status: "coming_soon" });
    expect(db.calls).toContain("update:coming_soon");
    expect(db.calls.at(-1)).toBe('record:site.status_changed:{"name":"Bakery","previousStatus":"live","newStatus":"coming_soon"}');
    expect(result.events).toEqual([{ type: "site.statusChanged", siteId: "site-1" }]);
  });

  it("the status the site already has: nothing written, recorded or flushed", async () => {
    db.status = "live";
    const result = await setSiteStatus(ctxFor(true), { status: "live" });
    expect(result).toMatchObject({ changed: false, events: [] });
    expect(db.calls).toEqual(["permission:site.settings.manage", "transaction", "lock"]);
  });

  it("a suspended site: refused as a conflict, nothing written or recorded", async () => {
    db.status = "suspended";
    for (const status of ["live", "coming_soon"]) {
      db.calls = [];
      const refusal = await setSiteStatus(ctxFor(true), { status }).catch((error: unknown) => error);
      expect(isAppError(refusal) && refusal.kind, status).toBe("Conflict");
      expect(db.calls, status).toEqual(["permission:site.settings.manage", "transaction", "lock"]);
    }
  });

  it("a site that is gone (deleted, or not this organization's) is not found", async () => {
    db.status = null;
    const refusal = await setSiteStatus(ctxFor(true), { status: "live" }).catch((error: unknown) => error);
    expect(isAppError(refusal) && refusal.kind).toBe("NotFound");
  });
});
