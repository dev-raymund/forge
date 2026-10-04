import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { identityDb } from "@/platform/db/identity";
import { AppError, notFound, unauthenticated, validationError } from "@/platform/errors";
import { getAuth, SESSION_ABSOLUTE_SECONDS } from "./auth";
import type { AuthRequest } from "./credentials.service";
import { UnexpectedAuthError } from "./credentials.service";
import { authFailureToAppError } from "./errors";
import { callAuth } from "./gateway";
import { authSessions } from "./schema";
import { resolveAuth } from "./session";
import type { Authenticated } from "./shared";
import { describeUserAgent } from "./user-agent";

/**
 * The signed-in user's sessions (M2-4): list them, end one, end all the others.
 *
 * Nothing that identifies a session inside Forge leaves the server. The list
 * carries an opaque `handle` per session: an HMAC of the user and session ids
 * under the auth secret. It means something only to this user, and only as
 * "one of my sessions"; it is neither the session id nor its token.
 */

export type SessionSummary = {
  /** Opaque reference for "end this session". Useless to anyone else, and for anything else. */
  handle: string;
  /** The session this request is using. */
  current: boolean;
  /** e.g. "Chrome on macOS". Coarse on purpose. */
  device: string;
  /** As recorded when the session was created; null when unknown. */
  ipAddress: string | null;
  createdAt: Date;
  /** When the session last slid forward: at most once a day, so read it as a date. */
  lastActiveAt: Date;
};

function handleFor(userId: string, sessionId: string): string {
  const secret = getAuth().options.secret!;
  return createHmac("sha256", secret).update(`forge:session-handle:${userId}:${sessionId}`).digest("base64url").slice(0, 32);
}

const sameHandle = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The user's live sessions: not idle-expired and inside the 30-day cap, like `resolveAuth()`. */
async function liveSessions(userId: string) {
  const now = new Date();
  const oldest = new Date(now.getTime() - SESSION_ABSOLUTE_SECONDS * 1000);
  return identityDb()
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, now), gt(authSessions.createdAt, oldest)))
    .orderBy(desc(authSessions.updatedAt));
}

/** The current session first, then the most recently active. */
export async function listSessions(auth: Authenticated): Promise<SessionSummary[]> {
  const rows = await liveSessions(auth.user.id);
  return rows
    .map((row) => ({
      handle: handleFor(auth.user.id, row.id),
      current: row.id === auth.session.id,
      device: describeUserAgent(row.userAgent),
      ipAddress: row.ipAddress || null,
      createdAt: row.createdAt,
      lastActiveAt: row.updatedAt,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current));
}

async function requireAuthFor(request: AuthRequest): Promise<Authenticated> {
  const auth = await resolveAuth(request.headers);
  if (!auth) throw unauthenticated();
  return auth;
}

function failure(operation: string, response: Awaited<ReturnType<typeof callAuth>>): AppError | UnexpectedAuthError {
  return authFailureToAppError(response) ?? new UnexpectedAuthError(operation, response);
}

/**
 * Ends one of the caller's other sessions. The handle is looked up among the
 * caller's own sessions only, so a handle that belongs to someone else's
 * session is simply not found; Better Auth then checks the owner once more
 * before deleting. The session stops working on its very next request.
 */
export async function revokeSession(handle: string, request: AuthRequest): Promise<void> {
  const auth = await requireAuthFor(request);
  const target = typeof handle === "string" ? (await liveSessions(auth.user.id)).find((row) => sameHandle(handleFor(auth.user.id, row.id), handle)) : undefined;
  if (!target) throw notFound();
  if (target.id === auth.session.id) throw validationError({ _form: ["To end this session, log out."] }, "To end this session, log out.");
  // The token goes from the database to Better Auth and nowhere else.
  const response = await callAuth("/revoke-session", request.headers, { token: target.token });
  if (response.status !== 200) throw failure("revoke-session", response);
}

/** Ends every session of the caller except the one making the request. Returns how many were ended. */
export async function revokeOtherSessions(request: AuthRequest): Promise<{ revoked: number }> {
  const auth = await requireAuthFor(request);
  const before = (await liveSessions(auth.user.id)).filter((row) => row.id !== auth.session.id).length;
  const response = await callAuth("/revoke-other-sessions", request.headers);
  if (response.status !== 200) throw failure("revoke-other-sessions", response);
  return { revoked: before };
}
