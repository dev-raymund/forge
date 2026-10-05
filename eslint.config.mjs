import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Module-boundary rules (v1-build-plan §18, cms-architecture §5.3).
 *
 * 1. Outside a module, import only its public entry points:
 *    `@/modules/<m>` (server API) or `@/modules/<m>/shared` (client-safe).
 *    Inside a module, use relative imports.
 * 2. The raw database client (`@/platform/db/client`) is private to
 *    `platform/`. Services and queries use `withTenant()` from `@/platform/db`.
 * 3. `app/` and `components/` never touch the database or Drizzle directly.
 * 4. Only `modules/auth` talks to Better Auth (D-07), and only it may take the
 *    identity-table handle Better Auth needs (`@/platform/db/identity`, ADR 0004).
 * 6. Only `platform/storage/providers` imports the S3 SDK, and the raw storage
 *    driver is private to `platform/`: application code uses `storageFor()` /
 *    `platformStorage()` from `@/platform/storage` (ADR 0008).
 * 5. Public site rendering never touches the session (ADR 0006): in V1 the
 *    admin and `/s/` sites share one origin, so site pages must stay identical
 *    for every visitor and never act as the signed-in admin.
 * 7. Nothing outside `modules/tenancy` decides by comparing a role (ADR 0009).
 *    What a role may do is the permission catalog's answer: ask
 *    `can(ctx, permission)` or `requirePermission(ctx, permission)`.
 */
const moduleEntryOnly = {
  group: ["@/modules/*/*", "!@/modules/*/shared"],
  message:
    "Import a module only through its public API: @/modules/<m> or @/modules/<m>/shared.",
};
const rawDbClient = {
  group: ["@/platform/db/client", "@/platform/db/client.*"],
  message: "The raw DB client is private to platform/. Use withTenant() from @/platform/db.",
};
const identityDb = {
  group: ["@/platform/db/identity", "@/platform/db/identity.*"],
  message: "The identity DB handle is for Better Auth in modules/auth only (ADR 0004).",
};
const betterAuth = {
  group: ["better-auth", "better-auth/*"],
  message: "Only modules/auth may import Better Auth (D-07).",
};
const s3Sdk = {
  group: ["@aws-sdk/*", "@smithy/*"],
  message: "Only platform/storage/providers may import the S3 SDK. Use @/platform/storage (ADR 0008).",
};
const rawStorageDriver = {
  group: ["@/platform/storage/get-driver", "@/platform/storage/providers/*"],
  message: "The raw storage driver is private to platform/. Use storageFor() from @/platform/storage.",
};
const noSessionInSites = {
  group: ["@/modules/auth", "@/modules/auth/*"],
  message: "Public site pages never read the session or cookies (ADR 0006).",
};
const noDbInUi = {
  group: ["@/platform/db", "@/platform/db/*", "drizzle-orm", "drizzle-orm/*", "pg"],
  message: "No database access in app/ or components/. Call a module's public API.",
};

const ROLE_LITERAL = "/^(owner|admin|editor|author|viewer)$/";
const ROLE_NAMED = ":matches([property.name=/role/i], [name=/role/i])";
const roleCheckMessage =
  "Do not decide by role. Ask can(ctx, permission) / requirePermission(ctx, permission) from @/modules/tenancy (ADR 0009).";
const noRoleChecks = [
  { selector: `BinaryExpression[operator=/^[!=]==?$/][right.value=${ROLE_LITERAL}] > ${ROLE_NAMED}.left`, message: roleCheckMessage },
  { selector: `BinaryExpression[operator=/^[!=]==?$/][left.value=${ROLE_LITERAL}] > ${ROLE_NAMED}.right`, message: roleCheckMessage },
  { selector: `SwitchStatement:has(SwitchCase > Literal.test[value=${ROLE_LITERAL}]) > ${ROLE_NAMED}.discriminant`, message: roleCheckMessage },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "drizzle/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "tests/fixtures/lint/**",
  ]),
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [moduleEntryOnly, rawDbClient, identityDb, betterAuth, s3Sdk, rawStorageDriver] },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/modules/tenancy/**"],
    rules: { "no-restricted-syntax": ["error", ...noRoleChecks] },
  },
  {
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [moduleEntryOnly, rawDbClient, identityDb, betterAuth, s3Sdk, rawStorageDriver, noDbInUi] },
      ],
    },
  },
  {
    files: ["src/app/(sites)/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [moduleEntryOnly, rawDbClient, identityDb, betterAuth, s3Sdk, rawStorageDriver, noDbInUi, noSessionInSites] },
      ],
    },
  },
  {
    files: ["src/modules/auth/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [moduleEntryOnly, rawDbClient, s3Sdk, rawStorageDriver] }],
    },
  },
  {
    files: ["src/platform/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [moduleEntryOnly, betterAuth, s3Sdk] }],
    },
  },
  {
    files: ["src/platform/storage/providers/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [moduleEntryOnly, betterAuth] }],
    },
  },
  {
    // Must stay last: later blocks override earlier ones in flat config.
    // Schema files may reference other modules' tables for foreign keys, and
    // the schema barrel re-exports every module's tables.
    files: ["src/modules/*/schema.ts", "src/platform/db/schema.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [rawDbClient, identityDb, betterAuth, s3Sdk, rawStorageDriver] }],
    },
  },
]);

export default eslintConfig;
