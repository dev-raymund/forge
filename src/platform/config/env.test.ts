import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, env, envStatus, REQUIRED_ENV_GROUPS, resetEnvCache } from "./env";

const base = {
  APP_ORIGIN: "https://app.forge.test",
  SITES_ROOT_DOMAIN: "sites.forge.test",
  DATABASE_URL: "postgres://forge_app:pw@db.example:5432/forge",
};

afterEach(() => resetEnvCache());

describe("env()", () => {
  it("parses a group with defaults and coercion", () => {
    expect(env("core", base)).toMatchObject({ APP_ORIGIN: base.APP_ORIGIN, LOG_LEVEL: "info", NODE_ENV: "development" });
    expect(env("database", { ...base, DATABASE_POOL_MAX: "5" }).DATABASE_POOL_MAX).toBe(5);
    expect(env("staff", { PLATFORM_ADMIN_EMAILS: " A@x.com, b@y.com ," }).PLATFORM_ADMIN_EMAILS).toEqual(["a@x.com", "b@y.com"]);
  });

  it("throws a ConfigError that names the variables but never their values", () => {
    const secretValue = "not-a-url-secret-value";
    try {
      env("database", { DATABASE_URL: secretValue });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).variables).toEqual(["DATABASE_URL"]);
      expect((e as Error).message).not.toContain(secretValue);
    }
  });

  it("treats empty strings as unset", () => {
    expect(() => env("cron", { CRON_SECRET: "" })).toThrow(ConfigError);
  });

  it("validates cross-field rules", () => {
    const auth = { BETTER_AUTH_SECRET: "x".repeat(32), BETTER_AUTH_URL: "https://app.forge.test" };
    expect(() => env("auth", { ...auth, GOOGLE_CLIENT_ID: "id" })).toThrow(ConfigError);
    expect(env("auth", { ...auth, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }).GOOGLE_CLIENT_ID).toBe("id");
  });
});

describe("envStatus()", () => {
  it("reports ok / missing / invalid per group without variable names", () => {
    const status = envStatus({ ...base, CRON_SECRET: "short" });
    expect(status).toMatchObject({ core: "ok", database: "ok", cron: "invalid", billing: "missing", observability: "ok" });
    expect(JSON.stringify(status)).not.toMatch(/[A-Z_]{4,}/);
  });

  it("requires only the groups shipped code reads today", () => {
    expect(REQUIRED_ENV_GROUPS).toEqual(["core", "database"]);
  });
});

describe("laziness", () => {
  it("importing the module does not read or validate anything", async () => {
    const saved = { ...process.env };
    try {
      delete process.env.APP_ORIGIN;
      delete process.env.DATABASE_URL;
      await expect(import("./env")).resolves.toBeDefined();
    } finally {
      process.env = saved;
    }
  });
});
