import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** `Authorization: Bearer <secret>` check in constant time (cron and internal routes). */
export function hasBearerSecret(headers: Headers, secret: string): boolean {
  const header = headers.get("authorization") ?? "";
  if (!secret || !header.startsWith("Bearer ")) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(secret));
}
