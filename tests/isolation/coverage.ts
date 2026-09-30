import type pg from "pg";
import { TABLE_CLASSES, type TableName } from "@/platform/db/table-classes";

/**
 * Catalog audit for tenant isolation (M1-6). Compares the live schema with the
 * table-class registry and returns every problem found:
 *   - a table in the database that is not classified
 *   - a classified table that does not exist
 *   - a tenant/membership table without RLS enabled AND forced
 *   - a non-tenant table with RLS (misclassified)
 *   - a tenant table without organization_id
 *   - ANY unclassified table that has an organization_id column (the most
 *     likely way to add an unprotected tenant table)
 */
export async function auditRlsCoverage(db: pg.Pool | pg.Client, schema = "public"): Promise<string[]> {
  const { rows } = await db.query<{ name: string; rls: boolean; force: boolean; has_org: boolean }>(
    `select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force,
            exists (select 1 from information_schema.columns col
                    where col.table_schema = n.nspname and col.table_name = c.relname
                      and col.column_name = 'organization_id') as has_org
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('r', 'p')`,
    [schema],
  );
  const problems: string[] = [];
  const present = new Set(rows.map((r) => r.name));

  for (const row of rows) {
    const cls = TABLE_CLASSES[row.name as TableName] as string | undefined;
    if (!cls) {
      problems.push(
        row.has_org
          ? `${row.name}: has organization_id but is not classified — an unprotected tenant table?`
          : `${row.name}: not classified in src/platform/db/table-classes.ts`,
      );
      continue;
    }
    const mustProtect = cls === "tenant" || cls === "membership";
    if (mustProtect && !(row.rls && row.force)) {
      problems.push(`${row.name}: ${cls} table without RLS ${row.rls ? "FORCE" : "enabled and forced"}`);
    }
    if (!mustProtect && row.rls) problems.push(`${row.name}: ${cls} table has RLS — misclassified?`);
    if (cls === "tenant" && !row.has_org) problems.push(`${row.name}: tenant table without organization_id`);
  }
  for (const name of Object.keys(TABLE_CLASSES)) {
    if (!present.has(name)) problems.push(`${name}: classified but missing from the database`);
  }
  return problems;
}
