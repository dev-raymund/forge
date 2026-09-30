/**
 * Spike S2 measurement: what does wrapping tenant reads in a transaction with
 * set_config cost, compared with three bare queries?
 *
 *   RLS_BENCH_URL=<pooled forge_app URL> npx tsx scripts/spikes/rls-latency.ts
 *
 * Defaults to the local PgBouncer. Run it once from a Vercel function region
 * against Neon's pooled endpoint for the real numbers (ADR 0001).
 */
import pg from "pg";

const URL = process.env.RLS_BENCH_URL ?? "postgres://forge_app:forge_app@localhost:6432/forge";
const N = Number(process.env.RLS_BENCH_ITERATIONS ?? 300);
const ORG = "01a0f24f-0000-7000-8000-000000000001";
const QUERIES = ["select count(*) from entries", "select count(*) from sites", "select count(*) from menus"];

const pct = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

async function main() {
  const pool = new pg.Pool({ connectionString: URL, max: 4 });
  const bare: number[] = [];
  const tenant: number[] = [];
  // warm up
  for (let i = 0; i < 20; i++) await pool.query("select 1");

  for (let i = 0; i < N; i++) {
    let start = performance.now();
    for (const q of QUERIES) await pool.query(q);
    bare.push(performance.now() - start);

    start = performance.now();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.org_id', $1, true), set_config('app.user_id', '', true)", [ORG]);
      for (const q of QUERIES) await client.query(q);
      await client.query("commit");
    } finally {
      client.release();
    }
    tenant.push(performance.now() - start);
  }
  await pool.end();

  const row = (name: string, xs: number[]) =>
    `${name.padEnd(28)} p50 ${pct(xs, 50).toFixed(2)} ms   p95 ${pct(xs, 95).toFixed(2)} ms`;
  console.log(`target: ${new globalThis.URL(URL).host}  iterations: ${N}`);
  console.log(row("3 bare queries", bare));
  console.log(row("withTenant (tx + set_config)", tenant));
  console.log(`overhead p50: ${(pct(tenant, 50) - pct(bare, 50)).toFixed(2)} ms (3 extra round trips: BEGIN, set_config, COMMIT)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
