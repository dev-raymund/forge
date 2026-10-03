import { logger, redact } from "@/platform/observability";

type Level = "debug" | "info" | "warn" | "error";

/**
 * Better Auth's log lines → Forge's JSON logger: one format, with the request
 * id, and without email addresses (Better Auth puts the address in at least
 * one message). Objects pass through the logger's key-based redaction.
 */
export function betterAuthLog(level: Level, message: string, ...args: unknown[]) {
  const err = args.find((a) => a instanceof Error);
  const text = [message, ...args.filter((a) => typeof a === "string")].join(" ").trim();
  const detail = args.filter((a) => a !== err && a !== null && typeof a === "object");
  logger[level](`better-auth: ${redact(text)}`, {
    module: "auth",
    ...(detail.length ? { detail } : {}),
    ...(err ? { err } : {}),
  });
}
