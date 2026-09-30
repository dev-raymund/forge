import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/platform/config/env";
import { readiness } from "./health";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

function setRequiredEnv() {
  Object.assign(process.env, {
    APP_ORIGIN: "https://app.forge.test",
    SITES_ROOT_DOMAIN: "sites.forge.test",
    DATABASE_URL: "postgres://u:p@h:5432/d",
  });
}

describe("readiness", () => {
  it("is ready when the database answers and required groups are valid", async () => {
    setRequiredEnv();
    const r = await readiness(async () => true);
    expect(r.ok).toBe(true);
    expect(r.checks).toMatchObject({ database: "ok", env: { core: "ok", database: "ok" } });
  });

  it("is not ready when the database is down", async () => {
    setRequiredEnv();
    expect(await readiness(async () => false)).toMatchObject({ ok: false, checks: { database: "fail" } });
  });

  it("is not ready when a required group is invalid, and does not name the variable", async () => {
    setRequiredEnv();
    process.env.APP_ORIGIN = "not a url";
    const r = await readiness(async () => true);
    expect(r).toMatchObject({ ok: false, checks: { env: { core: "invalid" } } });
    expect(JSON.stringify(r)).not.toContain("APP_ORIGIN");
  });

  it("optional groups do not affect readiness", async () => {
    setRequiredEnv();
    delete process.env.STRIPE_SECRET_KEY;
    expect((await readiness(async () => true)).ok).toBe(true);
  });
});
