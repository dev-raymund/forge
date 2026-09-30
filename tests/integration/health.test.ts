import { describe, expect, it } from "vitest";
import { pingDatabase } from "@/platform/db";
import { readiness } from "@/platform/observability/health";

describe("readiness against the real pooled database", () => {
  it("pings through PgBouncer as forge_app", async () => {
    expect(await pingDatabase()).toBe(true);
  });

  it("reports the database as ok", async () => {
    const r = await readiness();
    expect(r.checks.database).toBe("ok");
    expect(r.checks.env.database).toBe("ok");
  });
});
