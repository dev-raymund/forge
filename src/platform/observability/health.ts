import "server-only";
import { envStatus, REQUIRED_ENV_GROUPS, type EnvGroup, type EnvGroupStatus } from "@/platform/config/env";
import { pingDatabase } from "@/platform/db";

export type Readiness = {
  ok: boolean;
  checks: { database: "ok" | "fail"; env: Record<EnvGroup, EnvGroupStatus> };
};

/**
 * `/api/health/ready`: the database answers and every required env group is
 * valid. Reports group names and states only, never which variable is wrong.
 */
export async function readiness(ping: () => Promise<boolean> = pingDatabase): Promise<Readiness> {
  const env = envStatus();
  const database = (await ping()) ? "ok" : "fail";
  const ok = database === "ok" && REQUIRED_ENV_GROUPS.every((g) => env[g] === "ok");
  return { ok, checks: { database, env } };
}
