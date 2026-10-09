import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Two projects (D-31):
 *  - unit:        fast, pure, no I/O. Colocated `*.test.ts(x)` under src/ + tests/unit
 *                 (+ spike unit tests). DOM tests opt in per file with
 *                 `// @vitest-environment happy-dom`.
 *  - integration: real Postgres (through PgBouncer, like Neon's pooled endpoint),
 *                 real migrations and RLS. Requires `npm run dev:services`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // The tsconfig path of the spikes (the public renderer still reads through spikes/rendering until M4-3).
      "@spikes": path.resolve(import.meta.dirname, "spikes"),
      // The real package throws outside React Server Components.
      "server-only": path.resolve(import.meta.dirname, "tests/setup/server-only-stub.ts"),
      // The theme kit's fonts (M4-4): the real loaders exist only after Next's compiler.
      "next/font/google": path.resolve(import.meta.dirname, "tests/setup/next-font-google-stub.ts"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}", "spikes/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "spikes/**/*.integration.test.ts"],
          // DOM tests parse hostile HTML: never let happy-dom fetch or run what it references.
          environmentOptions: {
            happyDOM: {
              settings: {
                disableIframePageLoading: true,
                disableJavaScriptFileLoading: true,
                disableJavaScriptEvaluation: true,
                disableCSSFileLoading: true,
                handleDisabledFileLoadingAsSuccess: true,
              },
            },
          },
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts", "spikes/**/*.integration.test.ts"],
          globalSetup: ["tests/setup/integration-global.ts"],
          setupFiles: ["tests/setup/integration-env.ts"],
          testTimeout: 30_000,
          hookTimeout: 120_000,
          // One cloned database per worker (tests/setup/db-urls.ts).
          maxWorkers: 4,
        },
      },
    ],
  },
});
