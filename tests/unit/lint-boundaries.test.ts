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

async function roleChecks(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-syntax");
}

describe("authorization goes through the permission catalog (ADR 0009)", () => {
  const adHoc = [
    `export const f = (member: { role: string }) => member.role === "owner";\n`,
    `export const f = (ctx: { membership: { role: string } }) => ctx.membership.role !== "viewer";\n`,
    `export const f = (role: string) => role == "admin";\n`,
    `export const f = (actorRole: string) => "editor" === actorRole;\n`,
    `export function f(m: { role: string }) { switch (m.role) { case "owner": return 1; default: return 0; } }\n`,
  ];

  it.each(adHoc)("rejects a decision made by comparing a role, outside modules/tenancy: %s", async (code) => {
    for (const filePath of ["src/modules/content/entry.service.ts", "src/app/(admin)/example.tsx", "src/components/admin/example.tsx", "src/platform/example.ts"]) {
      const errors = await roleChecks(code, filePath);
      expect(errors, filePath).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/can\(ctx, permission\)/);
    }
  });

  it("leaves the tenancy module, where the Owner invariants live, alone", async () => {
    for (const code of adHoc) expect(await roleChecks(code, "src/modules/tenancy/membership-rules.ts")).toHaveLength(0);
  });

  it("does not mistake other comparisons for role checks", async () => {
    const fine = [
      `export const f = (el: { role: string }) => el.role === "alert";\n`, // ARIA
      `export const f = (kind: string) => kind === "owner";\n`, // not a role
      `export const f = (member: { role: string }, other: { role: string }) => member.role === other.role;\n`,
      `export const f = (plan: string) => plan === "admin";\n`,
    ];
    for (const code of fine) expect(await roleChecks(code, "src/modules/content/entry.service.ts"), code).toHaveLength(0);
  });
});

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

  it("keeps the S3 SDK inside platform/storage/providers", async () => {
    const code = `import { S3Client } from "@aws-sdk/client-s3";\nexport const c = S3Client;\n`;
    expect(await restrictedImports(code, "src/modules/media/upload.service.ts")).toHaveLength(1);
    expect((await restrictedImports(code, "src/app/(admin)/example.ts")).length).toBeGreaterThan(0);
    expect(await restrictedImports(code, "src/platform/jobs/example.ts")).toHaveLength(1);
    expect(await restrictedImports(code, "src/platform/storage/scoped.ts")).toHaveLength(1);
    expect(await restrictedImports(code, "src/platform/storage/providers/s3.ts")).toHaveLength(0);
  });

  it("keeps the raw storage driver private to platform/", async () => {
    const raw = `import { getStorageDriver } from "@/platform/storage/get-driver";\nexport const d = getStorageDriver;\n`;
    const provider = `import { S3StorageDriver } from "@/platform/storage/providers/s3";\nexport const d = S3StorageDriver;\n`;
    const scoped = `import { storageFor } from "@/platform/storage";\nexport const d = storageFor;\n`;
    expect(await restrictedImports(raw, "src/modules/media/upload.service.ts")).toHaveLength(1);
    expect(await restrictedImports(provider, "src/modules/media/upload.service.ts")).toHaveLength(1);
    expect(await restrictedImports(scoped, "src/modules/media/upload.service.ts")).toHaveLength(0);
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
