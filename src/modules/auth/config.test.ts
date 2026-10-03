import { beforeEach, describe, expect, it } from "vitest";
import { ConfigError, resetEnvCache } from "@/platform/config/env";
import { authConfig, DEVELOPMENT_AUTH_SECRET, turnstileSiteKey } from "./config";

const SECRET = "0123456789abcdef0123456789abcdef-production";
const local = { APP_ORIGIN: "http://localhost:3000" };
const turnstile = { TURNSTILE_SECRET_KEY: "turnstile-secret", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "turnstile-site" };
const production = { APP_ORIGIN: "https://cms.forgelinetechnologies.com", VERCEL_ENV: "production", ...turnstile };

beforeEach(() => resetEnvCache());

describe("authConfig", () => {
  it("needs nothing on localhost: a development secret, no Google", () => {
    expect(authConfig(local)).toEqual({
      baseURL: "http://localhost:3000", secret: DEVELOPMENT_AUTH_SECRET, google: undefined, turnstileSecretKey: undefined,
    });
  });

  it("uses BETTER_AUTH_SECRET when it is set, also locally", () => {
    expect(authConfig({ ...local, BETTER_AUTH_SECRET: SECRET }).secret).toBe(SECRET);
  });

  it("refuses to start without a secret anywhere else, naming the variable", () => {
    expect(() => authConfig(production)).toThrow(ConfigError);
    expect(() => authConfig(production)).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => authConfig({ APP_ORIGIN: "https://staging.example.com" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => authConfig({ ...local, VERCEL_ENV: "preview" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("the base URL is the app origin unless BETTER_AUTH_URL overrides it", () => {
    expect(authConfig({ ...production, BETTER_AUTH_SECRET: SECRET }).baseURL).toBe("https://cms.forgelinetechnologies.com");
    expect(authConfig({ ...production, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: "https://auth.example.com/" }).baseURL).toBe("https://auth.example.com");
  });

  it("enables Google only when both credentials are present", () => {
    const both = { ...local, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
    expect(authConfig(both).google).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(() => authConfig({ ...local, GOOGLE_CLIENT_ID: "id" })).toThrow(/GOOGLE_CLIENT_SECRET/);
    expect(() => authConfig({ ...local, GOOGLE_CLIENT_SECRET: "secret" })).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it("Turnstile: off without keys (local, previews); on with both; required on Vercel production", () => {
    expect(authConfig(local).turnstileSecretKey).toBeUndefined();
    expect(turnstileSiteKey(local)).toBeUndefined();
    expect(authConfig({ ...local, ...turnstile }).turnstileSecretKey).toBe("turnstile-secret");
    expect(turnstileSiteKey({ ...local, ...turnstile })).toBe("turnstile-site");
    expect(() => authConfig({ ...local, TURNSTILE_SECRET_KEY: "only-one" })).toThrow(/NEXT_PUBLIC_TURNSTILE_SITE_KEY/);
    const bare = { APP_ORIGIN: production.APP_ORIGIN, VERCEL_ENV: "production", BETTER_AUTH_SECRET: SECRET };
    expect(() => authConfig(bare)).toThrow(/TURNSTILE_SECRET_KEY/); // never silently without the challenge in production
    expect(authConfig({ ...bare, ...turnstile }).turnstileSecretKey).toBe("turnstile-secret");
  });
});
