import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { captcha } from "better-auth/plugins";
import { uuidv7 } from "uuidv7";
import { ConfigError } from "@/platform/config/env";
import { identityDb } from "@/platform/db/identity";
import { sendEmailSoon } from "@/platform/email";
import { problemResponse, unavailable } from "@/platform/errors";
import { reportError, requestIdFrom } from "@/platform/observability";
import { authConfig, type AuthConfig } from "./config";
import { betterAuthLog } from "./log";
import { authAccounts, authSessions, authVerifications, users } from "./schema";
import { SESSION_IDLE_SECONDS } from "./cookie";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./validation";

/**
 * Better Auth on Forge's identity tables (D-07, ADR 0004). This module is the
 * only place that imports Better Auth; everything else uses the helpers in
 * ./session.ts.
 *
 * Better Auth owns identity: users, credentials, sessions, verification and
 * reset tokens. It knows nothing about organizations, roles or sites.
 */

const DAY = 60 * 60 * 24;
/** Plan §12: 7-day sliding idle window (SESSION_IDLE_SECONDS), 30-day absolute lifetime. */
export { SESSION_IDLE_SECONDS };
export const SESSION_ABSOLUTE_SECONDS = 30 * DAY;
export const RESET_TOKEN_MINUTES = 60;
export const AUTH_BASE_PATH = "/api/auth";
/** Sent by our own sign-up form; checked by the captcha plugin when Turnstile is configured. */
export const CAPTCHA_HEADER = "x-captcha-response";

export function createAuth(config: AuthConfig) {
  return betterAuth({
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    // CSRF: state-changing requests and every callback/redirect URL must be on this origin.
    trustedOrigins: [new URL(config.baseURL).origin],
    telemetry: { enabled: false },
    logger: { disableColors: true, log: betterAuthLog },

    database: drizzleAdapter(identityDb(), {
      provider: "pg",
      // Better Auth's model names → our tables. Property names already match its field names.
      schema: { user: users, account: authAccounts, session: authSessions, verification: authVerifications },
    }),
    // Reset tokens and OAuth state are stored as SHA-256 hashes: reading the
    // table does not yield a usable token.
    verification: { storeIdentifier: "hashed" },
    advanced: {
      database: { generateId: () => uuidv7() },
      // Explicit, because Better Auth turns both checks off by itself when NODE_ENV
      // is "test" (or TEST is set). They are never off here, in any environment.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },

    // Not part of V1 (the account page offers name, avatar, password and sessions only).
    disabledPaths: ["/change-email", "/delete-user", "/delete-user/callback", "/link-social", "/unlink-account"],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      // Verification gates publishing, inviting and domains (§12), not login.
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: RESET_TOKEN_MINUTES * 60,
      revokeSessionsOnPasswordReset: true,
      // Better Auth owns the token; we only queue the email (ADR 0007). Delivery
      // happens in the job and can never fail or slow down the reset request.
      sendResetPassword: async ({ user, url }) => {
        await sendEmailSoon({ template: "reset-password", userId: user.id, url, expiresInMinutes: RESET_TOKEN_MINUTES });
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmailSoon({ template: "verify-email", userId: user.id, url });
      },
    },

    socialProviders: config.google ? { google: config.google } : {},
    account: {
      // Google is linked to an existing user only when Google asserts a verified
      // email AND the local user has verified the same address (Better Auth's
      // default). No trustedProviders: an unverified claim never links.
      accountLinking: { enabled: true },
    },

    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: DAY,
      cookieCache: { enabled: false }, // every request checks the database: revocation is immediate
    },

    databaseHooks: {
      session: {
        update: {
          // Better Auth has no absolute session lifetime. When a session slides
          // forward, cap it at created_at + 30 days. resolveAuth() enforces the
          // same limit on read, so the cap holds even if this hook is bypassed.
          before: async (data, ctx) => {
            const current = ctx?.context.session?.session;
            if (!current || !(data.expiresAt instanceof Date)) return;
            const cap = new Date(new Date(current.createdAt).getTime() + SESSION_ABSOLUTE_SECONDS * 1000);
            if (data.expiresAt > cap) return { data: { ...data, expiresAt: cap } };
          },
        },
      },
    },

    // Better Auth's default is on in production only; tests turn it on to prove the forms are limited.
    ...(config.rateLimit === undefined ? {} : { rateLimit: { enabled: config.rateLimit } }),

    plugins: [
      // Turnstile on sign-up (plan §12). Enforced here, in front of the endpoint,
      // so the form and a direct call to /api/auth/sign-up/email are both covered.
      ...(config.turnstileSecretKey
        ? [captcha({ provider: "cloudflare-turnstile", secretKey: config.turnstileSecretKey, endpoints: ["/sign-up/email"] })]
        : []),
      // Must stay last: lets code that calls the auth API directly set cookies.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

/** The configured instance, built on first use (never at import). */
export function getAuth(): Auth {
  instance ??= createAuth(authConfig());
  return instance;
}

/** Tests: use this instance; null restores configuration. */
export function setAuthForTests(auth: Auth | null) {
  instance = auth ?? undefined;
}

async function handle(request: Request): Promise<Response> {
  try {
    return await getAuth().handler(request);
  } catch (err) {
    if (err instanceof ConfigError) {
      reportError(err, { module: "auth" });
      return problemResponse(unavailable(err), requestIdFrom(request.headers));
    }
    throw err;
  }
}

/** For `src/app/api/auth/[...all]/route.ts`. */
export const authRouteHandlers = { GET: handle, POST: handle };
