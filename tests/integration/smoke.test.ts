import pg from "pg";
import { describe, expect, it } from "vitest";

describe("integration test project", () => {
  it("reaches Postgres through the transaction-mode pooler as forge_app", async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ role: string; bypass: boolean }>(
        "select current_user as role, rolbypassrls as bypass from pg_roles where rolname = current_user",
      );
      expect(rows[0]).toEqual({ role: "forge_app", bypass: false });
    } finally {
      await client.end();
    }
  });
});
