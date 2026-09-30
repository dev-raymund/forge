import { connection } from "next/server";
import { readiness } from "@/platform/observability";

/** Readiness: database reachable and required env groups valid (uptime checks poll this). */
export async function GET() {
  await connection();
  const result = await readiness();
  return Response.json(result, { status: result.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
