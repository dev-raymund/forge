/**
 * Await a promise that must fail with a Postgres error and return the
 * underlying error. Drizzle wraps driver errors ("Failed query: …") and keeps
 * the Postgres error in `.cause`.
 */
export type PgErrorShape = { code?: string; constraint?: string; message: string };

export async function dbError(promise: Promise<unknown>): Promise<PgErrorShape> {
  try {
    await promise;
  } catch (err) {
    const pgErr = (err as { cause?: unknown }).cause ?? err;
    const e = pgErr as { code?: string; constraint?: string; message?: string };
    return { code: e.code, constraint: e.constraint, message: e.message ?? String(pgErr) };
  }
  throw new Error("expected the database operation to fail, but it succeeded");
}

/** SQLSTATE codes asserted in tests. */
export const PG = {
  insufficientPrivilege: "42501", // also raised for RLS WITH CHECK violations
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  uniqueViolation: "23505",
} as const;
