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

export const EMAIL_PROVIDERS = ["resend", "mailpit", "console"] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];
const SENDER = /^(?:[^<>\r\n]{1,100} <[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;

/** Resend on Vercel production unless set explicitly; a non-sending provider everywhere else. */
export function resolveEmailProvider(v: { EMAIL_PROVIDER?: EmailProviderName; VERCEL_ENV?: string }): EmailProviderName {
  return v.EMAIL_PROVIDER ?? (v.VERCEL_ENV === "production" ? "resend" : "console");
}

/** The development secret is acceptable only for an app served from localhost, never on Vercel. */
export function allowsDevelopmentAuthSecret(v: { APP_ORIGIN?: string; BETTER_AUTH_URL?: string; VERCEL_ENV?: string }): boolean {
  if (v.VERCEL_ENV) return false;
  try {
    const { hostname } = new URL(v.BETTER_AUTH_URL ?? v.APP_ORIGIN ?? "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

export const STORAGE_DRIVERS = ["local", "s3"] as const;
export type StorageDriverName = (typeof STORAGE_DRIVERS)[number];

/** S3 on Vercel unless set explicitly; the local filesystem everywhere else. */
export function resolveStorageDriver(v: { STORAGE_DRIVER?: StorageDriverName; VERCEL_ENV?: string }): StorageDriverName {
  return v.STORAGE_DRIVER ?? (v.VERCEL_ENV ? "s3" : "local");
}

const schemas = {
  core: z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** The one origin of the V1 deployment (admin, API, /s/ sites, /media). On previews it defaults to the branch URL. */
    APP_ORIGIN: z.url(),
    /** Post-V1: tenant sites on their own hosts (platform subdomains, custom domains). Off in V1 (ADR 0006). */
    HOST_ROUTING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    /** Host mode only: `{address}.{SITES_ROOT_DOMAIN}` hosts. */
    SITES_ROOT_DOMAIN: hostname.optional(),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
    VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  }),
  database: z.object({
    DATABASE_URL: z.url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  }),
  /**
   * Authentication (M2-1, ADR 0004). The signing secret is required everywhere
   * except on a localhost origin, where a fixed development secret is used so
   * local sign-in needs no configuration. Google OAuth is optional.
   */
  auth: z
    .object({
      BETTER_AUTH_SECRET: secret(32).optional(),
      /** Defaults to APP_ORIGIN (V1 has one origin). */
      BETTER_AUTH_URL: z.url().optional(),
      GOOGLE_CLIENT_ID: z.string().optional(),
      GOOGLE_CLIENT_SECRET: z.string().optional(),
      APP_ORIGIN: z.url().optional(),
      VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
    })
    .superRefine((v, ctx) => {
      if (!!v.GOOGLE_CLIENT_ID !== !!v.GOOGLE_CLIENT_SECRET) {
        const missing = v.GOOGLE_CLIENT_ID ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID";
        ctx.addIssue({ code: "custom", path: [missing], message: "Google OAuth needs both the client id and the secret" });
      }
      if (!v.BETTER_AUTH_SECRET && !allowsDevelopmentAuthSecret(v)) {
        ctx.addIssue({ code: "custom", path: ["BETTER_AUTH_SECRET"], message: "Required outside local development" });
      }
    }),
  /**
   * Transactional email (M1-4). The provider defaults to `resend` on Vercel
   * production and to `console` elsewhere; local development sets `mailpit`.
   * Only `resend` needs credentials, and only it may send real email.
   */
  email: z
    .object({
      EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).optional(),
      /** The platform sender, e.g. `Forge <no-reply@cms.forgelinetechnologies.com>`. Never caller-controlled. */
      EMAIL_FROM: z.string().regex(SENDER, "Expected `Name <address@domain>` or `address@domain`").optional(),
      RESEND_API_KEY: z.string().min(1).optional(),
      MAILPIT_URL: z.url().optional(),
      VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
    })
    .superRefine((v, ctx) => {
      if (resolveEmailProvider(v) !== "resend") return;
      if (!v.RESEND_API_KEY) ctx.addIssue({ code: "custom", path: ["RESEND_API_KEY"], message: "Required for Resend" });
      if (!v.EMAIL_FROM) ctx.addIssue({ code: "custom", path: ["EMAIL_FROM"], message: "Required for Resend" });
    }),
  /**
   * Object storage (M1-5, ADR 0008). The driver defaults to `s3` on Vercel
   * (its filesystem is not durable) and to `local` elsewhere, so development
   * and tests need no storage account. Only `s3` needs credentials. Works with
   * any S3-compatible store; Cloudflare R2 is configuration, not code.
   */
  storage: z
    .object({
      STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).optional(),
      /** Local driver: where objects are kept. Default `.storage` (gitignored). */
      STORAGE_LOCAL_DIR: z.string().min(1).optional(),
      STORAGE_BUCKET: z.string().min(1).optional(),
      STORAGE_ENDPOINT: z.url().optional(),
      /** `auto` for Cloudflare R2. */
      STORAGE_REGION: z.string().min(1).default("auto"),
      STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
      STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
      /** Path-style addressing (`endpoint/bucket/key`): right for R2, RustFS and MinIO. */
      STORAGE_FORCE_PATH_STYLE: z
        .enum(["true", "false"])
        .default("true")
        .transform((v) => v === "true"),
      /** Public media URL prefix. Default (V1): `${APP_ORIGIN}/media`, served by the app; a CDN domain later. */
      MEDIA_PUBLIC_BASE_URL: z.url().optional(),
      VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
    })
    .superRefine((v, ctx) => {
      if (resolveStorageDriver(v) !== "s3") return;
      for (const name of ["STORAGE_BUCKET", "STORAGE_ENDPOINT", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"] as const) {
        if (!v[name]) ctx.addIssue({ code: "custom", path: [name], message: "Required for the s3 storage driver" });
      }
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
export const REQUIRED_ENV_GROUPS: readonly EnvGroup[] = ["core", "database", "auth", "email", "storage"];

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

/**
 * Vercel preview deployments each have their own URL. When APP_ORIGIN is not
 * set for the Preview environment, use the branch URL so auth, links and
 * readiness work there without per-branch configuration.
 */
function withDerivedDefaults(group: EnvGroup, values: Record<string, string | undefined>, source: Source) {
  if ("APP_ORIGIN" in values && !values.APP_ORIGIN && source.VERCEL_ENV === "preview") {
    const host = source.VERCEL_BRANCH_URL || source.VERCEL_URL;
    if (host) values.APP_ORIGIN = `https://${host}`;
  }
  return values;
}

function read(group: EnvGroup, source: Source) {
  const schema = schemas[group];
  const keys = Object.keys(schema.shape);
  // Empty strings mean "unset" (.env files commonly carry `NAME=`).
  const raw = Object.fromEntries(keys.map((k) => [k, source[k] === "" ? undefined : source[k]]));
  const values = withDerivedDefaults(group, raw, source);
  return { keys, values, result: schema.safeParse(values) };
}

/** Public base URL for media objects (V1: the app's own /media route). */
export function mediaPublicBaseUrl(source: Source = process.env): string {
  const configured = source.MEDIA_PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  return `${env("core", source).APP_ORIGIN.replace(/\/$/, "")}/media`;
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
