import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { uuidv7 } from "uuidv7";
import { authAccounts, authSessions, authVerifications, users } from "@/modules/auth/schema";
import { identityDb } from "@/platform/db/identity";

/**
 * Spike S4 / M0-6 (ADR 0004): Better Auth on Forge's own identity tables.
 *
 * Production-shaped configuration from v1-build-plan §12, minus what later
 * issues own (email jobs M1-4/M2-1, reset + Google UI M2-3, rate limits and
 * Turnstile M2-4). M2-1 moves this into src/modules/auth.
 */

const DAY = 60 * 60 * 24;
export const SESSION_IDLE_SECONDS = 7 * DAY;
export const SESSION_ABSOLUTE_SECONDS = 30 * DAY;

export type VerificationMail = { userId: string; email: string; url: string; token: string };

export type SpikeAuthOptions = {
  baseURL: string;
  secret: string;
  /**
   * Better Auth's email hooks. Production wiring (M1-4, used by M2-1):
   * `sendEmailSoon({ template: "verify-email" | "reset-password", userId, url })`
   * from `@/platform/email`, which queues `email.send`. Better Auth keeps owning the
   * tokens; delivery happens later in the job and can't fail the auth request.
   */
  sendVerificationEmail: (mail: VerificationMail) => Promise<void>;
  sendPasswordResetEmail?: (mail: VerificationMail) => Promise<void>;
  google?: { clientId: string; clientSecret: string };
};

export function createSpikeAuth(options: SpikeAuthOptions) {
  return betterAuth({
    baseURL: options.baseURL,
    basePath: "/api/auth",
    secret: options.secret,
    trustedOrigins: [new URL(options.baseURL).origin],
    telemetry: { enabled: false },

    database: drizzleAdapter(identityDb(), {
      provider: "pg",
      // Better Auth's model names → our tables (D-07). Property names in the
      // Drizzle tables already match Better Auth's field names.
      schema: { user: users, account: authAccounts, session: authSessions, verification: authVerifications },
    }),

    advanced: {
      database: { generateId: () => uuidv7() },
    },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      // Verification gates publishing, inviting and domains (§12), not login.
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: 60 * 60, // plan §12: 60 min, single use
      revokeSessionsOnPasswordReset: true, // plan §12
      ...(options.sendPasswordResetEmail
        ? {
            sendResetPassword: async ({ user, url, token }: { user: { id: string; email: string }; url: string; token: string }) =>
              options.sendPasswordResetEmail!({ userId: user.id, email: user.email, url, token }),
          }
        : {}),
    },

    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url, token }) =>
        options.sendVerificationEmail({ userId: user.id, email: user.email, url, token }),
    },

    socialProviders: options.google ? { google: options.google } : {},

    account: {
      // Auto-link only when Google asserts a verified email AND the local user
      // has verified the same address (requireLocalEmailVerified, default
      // true). No trustedProviders: an unverified claim never links.
      accountLinking: { enabled: true },
    },

    session: {
      expiresIn: SESSION_IDLE_SECONDS, // 7-day sliding idle window
      updateAge: DAY,
      cookieCache: { enabled: false }, // revocation must take effect on the next request
    },

    databaseHooks: {
      session: {
        update: {
          // Better Auth has no absolute session lifetime. When getSession slides
          // a session forward, cap it at created_at + 30 days (§12).
          before: async (data, ctx) => {
            const current = ctx?.context.session?.session;
            if (!current || !(data.expiresAt instanceof Date)) return;
            const cap = new Date(new Date(current.createdAt).getTime() + SESSION_ABSOLUTE_SECONDS * 1000);
            if (data.expiresAt > cap) return { data: { ...data, expiresAt: cap } };
          },
        },
      },
    },
  });
}

export type SpikeAuth = ReturnType<typeof createSpikeAuth>;
