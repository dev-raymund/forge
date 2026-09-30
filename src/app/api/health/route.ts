import { connection } from "next/server";

/** Liveness: the process answers. Readiness is /api/health/ready. */
export async function GET() {
  await connection(); // never prerendered: health must reflect the running instance
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
