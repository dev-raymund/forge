import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The module-boundary rules are enforced by ESLint (eslint.config.mjs). These
 * tests lint small snippets as if they lived at specific paths, proving that a
 * violation fails lint and a legal import passes.
 */
const eslint = new ESLint({ cwd: process.cwd() });

async function restrictedImports(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports");
}

describe("module boundaries", () => {
  it("rejects deep imports into another module from app/", async () => {
    const errors = await restrictedImports(
      `import { x } from "@/modules/content/entry.repository";\nexport const y = x;\n`,
      "src/app/(admin)/example.ts",
    );
    expect(errors).toHaveLength(1);
  });

  it("allows a module's public entry points", async () => {
    const errors = await restrictedImports(
      `import { a } from "@/modules/content";\nimport { b } from "@/modules/content/shared";\nexport const c = [a, b];\n`,
      "src/app/(admin)/example.ts",
    );
    expect(errors).toHaveLength(0);
  });

  it("rejects database access from app/", async () => {
    const errors = await restrictedImports(
      `import { sql } from "drizzle-orm";\nexport const q = sql\`select 1\`;\n`,
      "src/app/(admin)/example.ts",
    );
    expect(errors).toHaveLength(1);
  });

  it("keeps the raw DB client private to platform/", async () => {
    const errors = await restrictedImports(
      `import { getPool } from "@/platform/db/client";\nexport const p = getPool;\n`,
      "src/modules/content/entry.service.ts",
    );
    expect(errors).toHaveLength(1);
  });

  it("keeps Better Auth inside modules/auth", async () => {
    const outside = await restrictedImports(
      `import { betterAuth } from "better-auth";\nexport const a = betterAuth;\n`,
      "src/modules/tenancy/context.ts",
    );
    const inside = await restrictedImports(
      `import { betterAuth } from "better-auth";\nexport const a = betterAuth;\n`,
      "src/modules/auth/auth.ts",
    );
    expect(outside).toHaveLength(1);
    expect(inside).toHaveLength(0);
  });

  it("keeps the session out of public site pages", async () => {
    const code = `import { getCurrentUser } from "@/modules/auth";\nexport const u = getCurrentUser;\n`;
    expect(await restrictedImports(code, "src/app/(sites)/render/[site]/[[...path]]/page.tsx")).toHaveLength(1);
    expect(await restrictedImports(code, "src/app/(admin)/example.tsx")).toHaveLength(0);
  });

  it("gives the identity DB handle to modules/auth only", async () => {
    const code = `import { identityDb } from "@/platform/db/identity";\nexport const d = identityDb;\n`;
    expect(await restrictedImports(code, "src/modules/content/entry.service.ts")).toHaveLength(1);
    // app/ also trips the no-DB-in-UI rule, so expect at least one error there.
    expect((await restrictedImports(code, "src/app/(admin)/example.ts")).length).toBeGreaterThan(0);
    expect(await restrictedImports(code, "src/modules/auth/auth.ts")).toHaveLength(0);
  });
});
