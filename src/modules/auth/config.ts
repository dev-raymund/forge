import "server-only";
import { env } from "@/platform/config/env";
import { logger } from "@/platform/observability";

export type AuthConfig = {
  /** The app origin; Better Auth is mounted at `{baseURL}/api/auth`. */
  baseURL: string;
  secret: string;
  google?: { clientId: string; clientSecret: string };
  /** Cloudflare Turnstile on sign-up. Absent: no challenge (local development, tests). */
  turnstileSecretKey?: string;
  /** Overrides Better Auth's default (on in production only). */
  rateLimit?: boolean;
};

/** Used only when the app is served from localhost (env validation guarantees it). */
export const DEVELOPMENT_AUTH_SECRET = "forge-local-development-secret-not-for-production";
let warned = false;

/**
 * Resolved lazily on first use; throws ConfigError (naming the variables) when
 * BETTER_AUTH_SECRET is missing outside local development.
 */
export function authConfig(source: Record<string, string | undefined> = process.env): AuthConfig {
  const vars = env("auth", source);
  const baseURL = (vars.BETTER_AUTH_URL ?? env("core", source).APP_ORIGIN).replace(/\/$/, "");
  if (!vars.BETTER_AUTH_SECRET && !warned) {
    warned = true;
    logger.warn("auth is using the local development secret; set BETTER_AUTH_SECRET for any shared environment", { module: "auth" });
  }
  return {
    baseURL,
    secret: vars.BETTER_AUTH_SECRET ?? DEVELOPMENT_AUTH_SECRET,
    google:
      vars.GOOGLE_CLIENT_ID && vars.GOOGLE_CLIENT_SECRET
        ? { clientId: vars.GOOGLE_CLIENT_ID, clientSecret: vars.GOOGLE_CLIENT_SECRET }
        : undefined,
    turnstileSecretKey: env("turnstile", source).TURNSTILE_SECRET_KEY,
  };
}

/** The public Turnstile key for the sign-up form, or undefined where Turnstile is not configured. */
export function turnstileSiteKey(source: Record<string, string | undefined> = process.env): string | undefined {
  return env("turnstile", source).NEXT_PUBLIC_TURNSTILE_SITE_KEY;
}
