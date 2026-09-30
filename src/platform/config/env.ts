import "server-only";
import { z } from "zod";

/**
 * Environment configuration (plan §M1-2, long-term §29). Variables are grouped
 * by the feature that needs them and validated lazily on first use, so
 * importing a module never throws on a missing variable. `/api/health/ready`
 * reports per-group status without naming variables.
 *
 * A group becomes REQUIRED when shipped code starts reading it: its issue adds
 * it to REQUIRED_ENV_GROUPS.
 */

const secret = (min: number) => z.string().min(min);
const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );
const hostname = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);

const schemas = {
  core: z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_ORIGIN: z.url(),
    SITES_ROOT_DOMAIN: hostname,
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
    VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  }),
  database: z.object({
    DATABASE_URL: z.url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  }),
  auth: z
    .object({
      BETTER_AUTH_SECRET: secret(32),
      BETTER_AUTH_URL: z.url(),
      GOOGLE_CLIENT_ID: z.string().optional(),
      GOOGLE_CLIENT_SECRET: z.string().optional(),
    })
    .refine((v) => !!v.GOOGLE_CLIENT_ID === !!v.GOOGLE_CLIENT_SECRET, {
      message: "Google OAuth needs both the client id and the secret",
    }),
  email: z.object({ RESEND_API_KEY: secret(1), EMAIL_FROM: z.string().min(3) }),
  storage: z.object({
    STORAGE_BUCKET: secret(1),
    STORAGE_ENDPOINT: z.url(),
    STORAGE_ACCESS_KEY_ID: secret(1),
    STORAGE_SECRET_ACCESS_KEY: secret(1),
    MEDIA_PUBLIC_BASE_URL: z.url(),
  }),
  billing: z.object({ STRIPE_SECRET_KEY: secret(1), STRIPE_WEBHOOK_SECRET: secret(1), STRIPE_PRICE_PRO: secret(1) }),
  domains: z.object({ VERCEL_API_TOKEN: secret(1), VERCEL_PROJECT_ID: secret(1), VERCEL_TEAM_ID: z.string().optional() }),
  cron: z.object({ CRON_SECRET: secret(16) }),
  preview: z.object({ PREVIEW_TOKEN_SECRET: secret(32) }),
  turnstile: z.object({ TURNSTILE_SECRET_KEY: secret(1), NEXT_PUBLIC_TURNSTILE_SITE_KEY: secret(1) }),
  observability: z.object({ SENTRY_DSN: z.url().optional() }),
  staff: z.object({ PLATFORM_ADMIN_EMAILS: csv }),
} as const;

export type EnvGroup = keyof typeof schemas;
export type Env<G extends EnvGroup> = z.infer<(typeof schemas)[G]>;
export type EnvGroupStatus = "ok" | "missing" | "invalid";

export const ENV_GROUPS = Object.keys(schemas) as EnvGroup[];

/** Groups that shipped code reads today; readiness fails if any is not "ok". */
export const REQUIRED_ENV_GROUPS: readonly EnvGroup[] = ["core", "database"];

export class ConfigError extends Error {
  constructor(
    readonly group: EnvGroup,
    readonly variables: string[],
  ) {
    // Variable names only, never values. Server logs only; readiness hides even the names.
    super(`Environment group "${group}" is invalid: ${variables.join(", ")}`);
    this.name = "ConfigError";
  }
}

type Source = Record<string, string | undefined>;
const cache = new Map<EnvGroup, unknown>();

function read(group: EnvGroup, source: Source) {
  const schema = schemas[group];
  const keys = Object.keys(schema.shape);
  // Empty strings mean "unset" (.env files commonly carry `NAME=`).
  const values = Object.fromEntries(keys.map((k) => [k, source[k] === "" ? undefined : source[k]]));
  return { keys, values, result: schema.safeParse(values) };
}

/** The validated variables of one group. Throws ConfigError when invalid. */
export function env<G extends EnvGroup>(group: G, source: Source = process.env): Env<G> {
  if (source === process.env && cache.has(group)) return cache.get(group) as Env<G>;
  const { result } = read(group, source);
  if (!result.success) {
    const vars = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? group)))];
    throw new ConfigError(group, vars);
  }
  if (source === process.env) cache.set(group, result.data);
  return result.data as Env<G>;
}

/** Per-group status for readiness: no variable names, no values. */
export function envStatus(source: Source = process.env): Record<EnvGroup, EnvGroupStatus> {
  return Object.fromEntries(
    ENV_GROUPS.map((group) => {
      const { keys, values, result } = read(group, source);
      if (result.success) return [group, "ok"];
      const anySet = keys.some((k) => values[k] !== undefined);
      return [group, anySet ? "invalid" : "missing"];
    }),
  ) as Record<EnvGroup, EnvGroupStatus>;
}

/** Tests only: forget cached groups after changing process.env. */
export function resetEnvCache() {
  cache.clear();
}
