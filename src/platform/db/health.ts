import "server-only";
import { getPool } from "./client";

/** Readiness probe: one round trip through the runtime pool, bounded in time. Never throws. */
export async function pingDatabase(timeoutMs = 3_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getPool().query("select 1"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("database ping timed out")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
