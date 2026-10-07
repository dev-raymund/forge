import { createHash, randomBytes } from "node:crypto";

/**
 * Invitation tokens. The token is 32 random bytes and exists in two places
 * only: the link in the invitation email, and the address bar of whoever opens
 * it. The database keeps its SHA-256, so neither a copy of the table nor a
 * query result can be turned back into a working link.
 */

const TOKEN_BYTES = 32;
/** 32 bytes as base64url: 43 characters of the URL-safe alphabet, no padding. */
const SHAPE = /^[A-Za-z0-9_-]{43}$/;

export const hashInvitationToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function newInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}

/** True for a string that could be a token. Anything else is refused before the database is asked. */
export const looksLikeInvitationToken = (value: unknown): value is string => typeof value === "string" && SHAPE.test(value);
