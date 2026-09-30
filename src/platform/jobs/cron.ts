import "server-only";
import { env } from "@/platform/config/env";
import { hasBearerSecret } from "@/platform/security/bearer";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without a configured secret nothing is authorized. */
export function isCronRequest(headers: Headers): boolean {
  let secret: string;
  try {
    secret = env("cron").CRON_SECRET;
  } catch {
    return false;
  }
  return hasBearerSecret(headers, secret);
}
