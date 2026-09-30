import { connection } from "next/server";

/** Liveness. Readiness (DB ping + env groups) arrives with M1-2. */
export async function GET() {
  await connection(); // never prerendered: health must reflect the running instance
  return Response.json({ ok: true });
}
