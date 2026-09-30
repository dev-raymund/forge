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
const noDbInUi = {
  group: ["@/platform/db", "@/platform/db/*", "drizzle-orm", "drizzle-orm/*", "pg"],
  message: "No database access in app/ or components/. Call a module's public API.",
};

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
        { patterns: [moduleEntryOnly, rawDbClient, identityDb, betterAuth] },
      ],
    },
  },
  {
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [moduleEntryOnly, rawDbClient, identityDb, betterAuth, noDbInUi] },
      ],
    },
  },
  {
    files: ["src/modules/auth/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [moduleEntryOnly, rawDbClient] }],
    },
  },
  {
    files: ["src/platform/**/*.{ts,tsx}"],
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
      "no-restricted-imports": ["error", { patterns: [rawDbClient, identityDb, betterAuth] }],
    },
  },
]);

export default eslintConfig;
