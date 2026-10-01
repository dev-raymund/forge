import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, env, envStatus, mediaPublicBaseUrl, REQUIRED_ENV_GROUPS, resetEnvCache } from "./env";

const base = {
  APP_ORIGIN: "https://cms.forgelinetechnologies.com",
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

describe("V1 single-host deployment", () => {
  it("needs only APP_ORIGIN: host routing is off and no sites domain is required", () => {
    expect(env("core", base)).toMatchObject({ HOST_ROUTING_ENABLED: false, SITES_ROOT_DOMAIN: undefined });
    expect(env("core", { ...base, HOST_ROUTING_ENABLED: "true", SITES_ROOT_DOMAIN: "sites.example.com" })).toMatchObject({
      HOST_ROUTING_ENABLED: true,
      SITES_ROOT_DOMAIN: "sites.example.com",
    });
  });

  it("derives APP_ORIGIN from the branch URL on Vercel previews when it is not set", () => {
    const preview = { VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "forge-git-feature-dev-raymund.vercel.app" };
    expect(env("core", preview).APP_ORIGIN).toBe("https://forge-git-feature-dev-raymund.vercel.app");
    expect(env("core", { ...preview, APP_ORIGIN: "https://cms.forgelinetechnologies.com" }).APP_ORIGIN).toBe(
      "https://cms.forgelinetechnologies.com",
    );
    expect(() => env("core", { VERCEL_ENV: "production", VERCEL_BRANCH_URL: "x.vercel.app" })).toThrow(ConfigError);
  });

  it("serves media from the app's /media route unless a media base URL is configured", () => {
    expect(mediaPublicBaseUrl(base)).toBe("https://cms.forgelinetechnologies.com/media");
    expect(mediaPublicBaseUrl({ ...base, MEDIA_PUBLIC_BASE_URL: "https://media.example.com/" })).toBe("https://media.example.com");
  });
});

describe("envStatus()", () => {
  it("reports ok / missing / invalid per group without variable names", () => {
    const status = envStatus({ ...base, CRON_SECRET: "short" });
    expect(status).toMatchObject({ core: "ok", database: "ok", cron: "invalid", billing: "missing", observability: "ok" });
    expect(JSON.stringify(status)).not.toMatch(/[A-Z_]{4,}/);
  });

  it("requires only the groups shipped code reads today", () => {
    expect(REQUIRED_ENV_GROUPS).toEqual(["core", "database", "email"]);
  });

  it("email: nothing needed locally; Resend (explicit, or the Vercel production default) needs a key and a sender", () => {
    expect(envStatus({ ...base }).email).toBe("ok");
    expect(envStatus({ ...base, EMAIL_PROVIDER: "mailpit" }).email).toBe("ok");
    expect(envStatus({ ...base, VERCEL_ENV: "production" }).email).toBe("invalid");
    expect(envStatus({ ...base, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" }).email).toBe("invalid");
    expect(
      envStatus({ ...base, VERCEL_ENV: "production", RESEND_API_KEY: "re_x", EMAIL_FROM: "Forge <no-reply@cms.example.com>" }).email,
    ).toBe("ok");
    expect(envStatus({ ...base, EMAIL_FROM: "not an address" }).email).toBe("invalid");
    expect(envStatus({ ...base, EMAIL_FROM: "Evil\r\nBcc: x@y.com <a@b.com>" }).email).toBe("invalid");
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
