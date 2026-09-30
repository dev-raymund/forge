import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Two projects (D-31):
 *  - unit:        fast, pure, no I/O. Colocated `*.test.ts(x)` under src/ + tests/unit.
 *  - integration: real Postgres (through PgBouncer, like Neon's pooled endpoint),
 *                 real migrations and RLS. Requires `npm run dev:services`.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/setup/integration-global.ts"],
          setupFiles: ["tests/setup/integration-env.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
