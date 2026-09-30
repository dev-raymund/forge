import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "@/platform/db/columns";

/**
 * Identity tables (class: identity — no RLS; only modules/auth touches them).
 *
 * Shaped for Better Auth's core schema (user / account / session / verification)
 * and mapped to our names (D-07). TypeScript property names match Better
 * Auth's field names; database columns are snake_case.
 */

export const users = pgTable(
  "users",
  {
    id: id(),
    name: text("name").notNull().default(""),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    ...timestamps(),
  },
  () => [check("users_email_lowercase", sql`${sql.identifier("email")} = lower(${sql.identifier("email")})`)],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "credential" for email/password; "google", "github", … for OAuth. */
    providerId: text("provider_id").notNull(),
    /** The provider's subject id (for credential accounts: the user id). */
    accountId: text("account_id").notNull(),
    /** scrypt hash, credential accounts only. */
    password: text("password"),
    // Provider tokens are stored only because Better Auth's account model has
    // them; V1 never calls provider APIs after sign-in.
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    ...timestamps(),
  },
  (t) => [
    index("auth_accounts_user_idx").on(t.userId),
    uniqueIndex("auth_accounts_provider_account_unique").on(t.providerId, t.accountId),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    ...timestamps(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId), index("auth_sessions_expires_idx").on(t.expiresAt)],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);
