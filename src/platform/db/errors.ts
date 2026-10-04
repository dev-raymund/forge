/**
 * Postgres errors, as far as services need to tell them apart. Drizzle wraps
 * the driver's error ("Failed query: …") and keeps the original in `.cause`.
 */
export type PgError = { code?: string; constraint?: string };

export function pgErrorOf(error: unknown): PgError | null {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      const constraint = (e as { constraint?: unknown }).constraint;
      return { code, constraint: typeof constraint === "string" ? constraint : undefined };
    }
  }
  return null;
}

/** SQLSTATE 23505. With `constraint`, only that unique constraint or index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = pgErrorOf(error);
  return pg?.code === "23505" && (constraint === undefined || pg.constraint === constraint);
}
