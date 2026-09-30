import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Structured JSON logger (long-term D-33): one JSON line per event with the
 * mandatory context `requestId`, `orgId`, `siteId`, `actor`, `module`.
 *
 * Context travels in AsyncLocalStorage **for logging only**: it is never read
 * for authorization or tenant scoping (that is explicit `ctx`, D-04). The
 * logger never throws.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = {
  requestId?: string;
  orgId?: string;
  siteId?: string;
  /** "user:{id}", "api_key:{id}", "system" — never an email. */
  actor?: string;
  module?: string;
};
export type LogFields = Record<string, unknown> & { err?: unknown; durationMs?: number };

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with extra logging context (merged over the current one). */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

// ── Redaction ────────────────────────────────────────────────────────────────

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|email|^ip$|session/i;
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return value.replace(EMAIL, "[email]");
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1)]),
    );
  }
  return value;
}

/** Name, message, code and stack only. Driver errors carry row values in `detail`; that is dropped. */
export function serializeError(err: unknown): Record<string, unknown> | undefined {
  if (err === undefined || err === null) return undefined;
  if (!(err instanceof Error)) return { message: redact(String(err)) };
  const e = err as Error & { kind?: string; code?: string };
  return {
    name: e.name,
    message: redact(e.message),
    ...(e.kind ? { kind: e.kind } : {}),
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    stack: e.stack,
    ...(e.cause !== undefined ? { cause: serializeError(e.cause) } : {}),
  };
}

// ── Output ───────────────────────────────────────────────────────────────────

type Sink = (level: LogLevel, line: string) => void;
const consoleSink: Sink = (level, line) => (level === "error" || level === "warn" ? console.error(line) : console.log(line));
let sink: Sink = consoleSink;

/** Tests only. */
export function setLogSink(next: Sink | null) {
  sink = next ?? consoleSink;
}

function threshold(): number {
  const level = process.env.LOG_LEVEL as LogLevel | undefined;
  return RANK[level ?? "info"] ?? RANK.info;
}

function write(level: LogLevel, bound: LogContext, msg: string, fields: LogFields = {}) {
  if (RANK[level] < threshold()) return;
  try {
    const { err, ...rest } = fields;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg,
      ...currentLogContext(),
      ...bound,
      ...(redact(rest) as object),
      ...(err !== undefined ? { err: serializeError(err) } : {}),
    });
    sink(level, line);
  } catch {
    // never let logging break a request
  }
}

export type Logger = {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
  child: (context: LogContext) => Logger;
};

function createLogger(bound: LogContext): Logger {
  return {
    debug: (msg, fields) => write("debug", bound, msg, fields),
    info: (msg, fields) => write("info", bound, msg, fields),
    warn: (msg, fields) => write("warn", bound, msg, fields),
    error: (msg, fields) => write("error", bound, msg, fields),
    child: (context) => createLogger({ ...bound, ...context }),
  };
}

export const logger: Logger = createLogger({});
