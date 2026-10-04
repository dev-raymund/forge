import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { captcha } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { recordPlatformEvent } from "@/modules/audit";
import { ConfigError } from "@/platform/config/env";
import { identityDb } from "@/platform/db/identity";
import { sendEmailSoon } from "@/platform/email";
import { problemResponse, unavailable } from "@/platform/errors";
import { reportError, requestIdFrom } from "@/platform/observability";
import { authConfig, type AuthConfig } from "./config";
import { betterAuthLog } from "./log";
import { ACCOUNT_LINKING } from "./oauth";
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

type EndpointContext = { path?: string; headers?: Headers; params?: Record<string, unknown> } | null | undefined;

/** The request id the proxy assigned and the client address, for audit rows. */
function requestFacts(ctx: EndpointContext) {
  const headers = ctx?.headers;
  return {
    requestId: headers ? requestIdFrom(headers) : undefined,
    ip: headers?.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) || undefined,
  };
}

/**
 * Account events for the audit trail (M2-4): org-less rows in `audit_logs`.
 * Better Auth has already done the thing when this runs, in its own queries, so
 * the row cannot share its transaction. A failure to write it is reported and
 * swallowed: an audit problem must not lock people out or leave them signed in.
 */
async function audit(action: string, userId: string, ctx: EndpointContext, metadata: Record<string, unknown> = {}) {
  try {
    const [user] = await identityDb().select({ email: users.email }).from(users).where(eq(users.id, userId));
    await recordPlatformEvent({ action, userId, userLabel: user?.email, ...requestFacts(ctx), metadata });
  } catch (error) {
    reportError(error, { module: "auth" }, { operation: `audit ${action}` });
  }
}

/** How a new session came about, from the endpoint that created it. `null`: not a login. */
function loginMethod(ctx: EndpointContext): string | null {
  switch (ctx?.path) {
    case "/sign-in/email":
      return "password";
    case "/sign-up/email":
      return "sign-up";
    case "/callback/:id": // the OAuth callback; `:id` is the provider
      return typeof ctx.params?.id === "string" ? ctx.params.id : "oauth";
    case "/sign-in/social":
      return "google-id-token";
    case "/change-password":
      return null; // the same person, on a fresh session after changing the password
    default:
      return "other";
  }
}

/**
 * After a password change, by reset link or while signed in: the audit row and
 * the "your password was changed" notice (ADR 0007: a job, sent after the
 * response). Neither can fail the change or stop the sessions from being revoked.
 */
async function afterPasswordChanged(userId: string, via: "reset" | "change", origin: string, ctx: EndpointContext) {
  await audit("auth.password_changed", userId, ctx, { via });
  try {
    await sendEmailSoon({ template: "password-changed", userId, url: `${origin}/forgot-password`, changedAt: new Date().toISOString() });
  } catch (error) {
    reportError(error, { module: "auth" }, { operation: "password-changed notice" });
  }
}

/** The only profile field a user can change in V1 (the avatar arrives with the media pipeline, M6). */
const EDITABLE_PROFILE_FIELDS = ["name"];

export function createAuth(config: AuthConfig) {
  const origin = new URL(config.baseURL).origin;
  return betterAuth({
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    // CSRF: state-changing requests and every callback/redirect URL must be on this origin.
    trustedOrigins: [origin],
    // OAuth failures land on our login page with `?error=<code>`, never on Better Auth's own error page.
    onAPIError: { errorURL: "/login" },
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
      // Runs once the new password is stored, before the user's sessions are revoked.
      onPasswordReset: async ({ user }, request) => afterPasswordChanged(user.id, "reset", origin, { headers: request?.headers }),
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // `/update-user` would also accept `image` (any URL) and other fields. V1 lets a user change the name only.
        if (ctx.path !== "/update-user") return;
        const fields = ctx.body && typeof ctx.body === "object" ? Object.keys(ctx.body as object) : [];
        if (fields.some((field) => !EDITABLE_PROFILE_FIELDS.includes(field))) {
          throw new APIError("BAD_REQUEST", { code: "FIELD_NOT_EDITABLE", message: "Only the name can be changed" });
        }
      }),
      // A password changed while signed in (`/change-password`, the account page).
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/change-password" || isAPIError(ctx.context.returned)) return;
        const userId = ctx.context.session?.user.id;
        if (userId) await afterPasswordChanged(userId, "change", origin, ctx);
      }),
    },

    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmailSoon({ template: "verify-email", userId: user.id, url });
      },
    },

    // Authorization-code flow with PKCE, default scopes (openid, email, profile).
    // `select_account`: Google always asks which account, so a shared computer
    // doesn't sign the next person in as the previous one.
    socialProviders: config.google ? { google: { ...config.google, prompt: "select_account" } } : {},
    account: {
      // Plan §12 and ./oauth.ts: link only when both sides have verified the same address.
      accountLinking: ACCOUNT_LINKING,
      // Forge never calls Google's APIs after sign-in, so it keeps none of Google's
      // tokens: nothing is written on sign-in, and nothing is stored when the
      // identity is first recorded (databaseHooks below).
      updateAccountOnSignIn: false,
    },

    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: DAY,
      cookieCache: { enabled: false }, // every request checks the database: revocation is immediate
    },

    databaseHooks: {
      account: {
        create: {
          // A stored ID token could be replayed to `/sign-in/social` for as long as
          // Google considers it fresh. Keep the identity (provider + subject), drop the tokens.
          before: async (account) => ({
            data: { ...account, accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null },
          }),
        },
      },
      session: {
        create: {
          // Every way of signing in ends here: one place for the audit row.
          after: async (session, ctx) => {
            const method = loginMethod(ctx);
            if (method) await audit("auth.login", session.userId, ctx, { method });
          },
        },
        delete: {
          // Logging out. Sessions ended from the account page, or by a reset, are not logouts.
          after: async (session, ctx) => {
            if (ctx?.path === "/sign-out") await audit("auth.logout", session.userId, ctx);
          },
        },
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

    // Per client address: 3 per 10 s for sign-in, sign-up and password changes, 3 per minute for
    // reset and verification emails, 100 per 10 s otherwise. On in production (stated here, not left
    // to the library's default); tests turn it on to prove the forms are limited. Counts are kept
    // per instance, so the WAF rule in the runbook is the outer limit (ADR 0004).
    rateLimit: { enabled: config.rateLimit ?? process.env.NODE_ENV === "production" },

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
