/**
 * Retry transient connection failures (ported from Forgeline's lib/queries.ts).
 *
 * Only connection-level failures retry — a cold or restarting Neon compute, a
 * pooler hiccup. SQL errors throw immediately: retrying bad SQL just delays the
 * same failure. Use only around idempotent work (reads, or writes guarded by
 * an idempotency key).
 */
const TRANSIENT =
  /fetch failed|ConnectTimeout|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|terminated|Connection terminated|timeout exceeded when trying to connect/i;

export function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  const code = (err as { code?: unknown }).code;
  // 57P01 admin_shutdown, 57P03 cannot_connect_now, 08xxx connection exceptions
  if (typeof code === "string" && (code === "57P01" || code === "57P03" || code.startsWith("08"))) {
    return true;
  }
  return TRANSIENT.test([err.message, err.name, String(cause ?? "")].join(" "));
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isTransientDbError(err) || i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** i));
    }
  }
  throw last;
}
