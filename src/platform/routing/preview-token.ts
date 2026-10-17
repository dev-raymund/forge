import { createHmac, timingSafeEqual } from "node:crypto";
import { allowsDevelopmentAuthSecret } from "@/platform/config/env";
import { PREVIEW_PATH_PREFIX, PREVIEW_TOKEN_SHAPE } from "./hosts";

export { PREVIEW_PATH_PREFIX, PREVIEW_TOKEN_SHAPE };

/**
 * Preview tokens (M7-4; plan §9 "Preview"; ADR 0006: `/_forge/preview/{token}`). A token names what it shows and who
 * asked, signed with `PREVIEW_TOKEN_SECRET` (HMAC-SHA256), and lasts 15 minutes:
 *
 *   o  the organization   s  the site   e  the entry   u  the user who asked   r  a revision (absent: the draft)
 *   x  when it expires (seconds since the epoch)
 *
 * The token alone identifies the site and the entry: preview pages are site pages, which never receive the admin's
 * session cookie (the proxy removes it, ADR 0006). So the token is checked twice: here, by the proxy, before anything
 * renders (a tampered, expired or malformed one is a 404), and again by the renderer, which also asks whether the user
 * may still see the entry now. Pure apart from `node:crypto`: unit tested, and used by the proxy and the services alike.
 */

export const PREVIEW_TOKEN_TTL_SECONDS = 15 * 60;

/** Accepted only for an app served from localhost (never on Vercel), as auth's development secret is. */
export const DEVELOPMENT_PREVIEW_SECRET = "forge-local-development-preview-secret-not-for-production";

export type PreviewClaims = { orgId: string; siteId: string; entryId: string; userId: string; revisionId: string | null; expiresAt: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The secret previews are signed with here, or null when previews are not set up (the services say so; the proxy answers 404). */
export function previewSecret(vars: Record<string, string | undefined> = process.env): string | null {
  const configured = vars.PREVIEW_TOKEN_SECRET;
  if (configured && configured.length >= 32) return configured;
  // An empty variable is an unset one (`.env` files write `NAME=`), as the env schemas read them.
  const set = (name: string) => vars[name] || undefined;
  return allowsDevelopmentAuthSecret({ APP_ORIGIN: set("APP_ORIGIN"), BETTER_AUTH_URL: set("BETTER_AUTH_URL"), VERCEL_ENV: set("VERCEL_ENV") }) ? DEVELOPMENT_PREVIEW_SECRET : null;
}

const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(`forge-preview:v1:${payload}`).digest("base64url");

export function signPreviewToken(claims: PreviewClaims, secret: string): string {
  const body = { v: 1, o: claims.orgId, s: claims.siteId, e: claims.entryId, u: claims.userId, ...(claims.revisionId ? { r: claims.revisionId } : {}), x: claims.expiresAt };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The claims of a token signed with `secret` that has not expired at `nowMs`; null for anything else. Constant-time comparison. */
export function verifyPreviewToken(token: string, secret: string, nowMs: number): PreviewClaims | null {
  if (!PREVIEW_TOKEN_SHAPE.test(token)) return null;
  const [payload, signature] = token.split(".") as [string, string];
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ids = [body.o, body.s, body.e, body.u];
  if (body.v !== 1 || !ids.every((id) => typeof id === "string" && UUID.test(id))) return null;
  if (body.r !== undefined && !(typeof body.r === "string" && UUID.test(body.r))) return null;
  if (typeof body.x !== "number" || !Number.isInteger(body.x) || body.x * 1000 <= nowMs) return null;
  return { orgId: body.o as string, siteId: body.s as string, entryId: body.e as string, userId: body.u as string, revisionId: (body.r as string | undefined) ?? null, expiresAt: body.x };
}

// ── M8-1: previews of appearance settings that are not saved ─────────────────

/**
 * An appearance preview's token: the organization, the site, the user, and the theme's kit-level settings it shows
 * (checked by the service that signs it, and again when the page is opened), for 15 minutes. Signed under its own
 * label, so neither kind of token can ever be read as the other.
 */
export type AppearanceClaims = { orgId: string; siteId: string; userId: string; settings: unknown; expiresAt: number };

const signAppearance = (payload: string, secret: string) => createHmac("sha256", secret).update(`forge-preview:appearance:v1:${payload}`).digest("base64url");

export function signAppearanceToken(claims: AppearanceClaims, secret: string): string {
  const body = { v: 1, k: "appearance", o: claims.orgId, s: claims.siteId, u: claims.userId, t: claims.settings, x: claims.expiresAt };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${signAppearance(payload, secret)}`;
}

export function verifyAppearanceToken(token: string, secret: string, nowMs: number): AppearanceClaims | null {
  if (!PREVIEW_TOKEN_SHAPE.test(token)) return null;
  const [payload, signature] = token.split(".") as [string, string];
  const expected = Buffer.from(signAppearance(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (body.v !== 1 || body.k !== "appearance" || ![body.o, body.s, body.u].every((id) => typeof id === "string" && UUID.test(id))) return null;
  if (typeof body.x !== "number" || !Number.isInteger(body.x) || body.x * 1000 <= nowMs) return null;
  return { orgId: body.o as string, siteId: body.s as string, userId: body.u as string, settings: body.t, expiresAt: body.x };
}
