import "server-only";
import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { identityDb } from "@/platform/db/identity";
import { forbidden, unauthenticated } from "@/platform/errors";
import { loginPath } from "@/platform/routing/admin-access";
import { getAuth, SESSION_ABSOLUTE_SECONDS } from "./auth";
import { findSessionCookie } from "./cookie";
import { authSessions } from "./schema";
import { ANONYMOUS, type Actor, type Authenticated, type AuthUser } from "./shared";

/**
 * Forge's session abstraction (M2-1). The rest of the application sees an
 * `Authenticated` value or null, never Better Auth's types.
 *
 * Authentication only answers "who is this?". It never implies access to an
 * organization or site: those come from the URL and are checked against
 * membership by the tenancy module (D-08, M3-2).
 */

type BetterAuthSession = NonNullable<Awaited<ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>>>;

/** Better Auth's session → our shape. Only the fields Forge uses cross this line. */
export function toAuthenticated(result: BetterAuthSession): Authenticated {
  return {
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      emailVerified: result.user.emailVerified,
      image: result.user.image ?? null,
    },
    session: {
      id: result.session.id,
      createdAt: new Date(result.session.createdAt),
      expiresAt: new Date(result.session.expiresAt),
    },
  };
}

/** Plan §12: a session ends 30 days after it was created, however active it is. */
export function withinAbsoluteLifetime(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() < SESSION_ABSOLUTE_SECONDS * 1000;
}

/**
 * Resolves the request's session from its headers (cookie). Every call checks
 * the database (no cookie cache), so logout and revocation apply immediately;
 * idle and absolute expiry are enforced here, on the server.
 */
export async function resolveAuth(requestHeaders: Headers): Promise<Authenticated | null> {
  const result = await getAuth().api.getSession({ headers: requestHeaders });
  if (!result) return null;
  const auth = toAuthenticated(result);
  if (!withinAbsoluteLifetime(auth.session.createdAt)) {
    await identityDb().delete(authSessions).where(eq(authSessions.id, auth.session.id));
    return null;
  }
  return auth;
}

/**
 * The current request's session, or null. Cached per request (React `cache`).
 * Reading headers makes the caller dynamic: under Cache Components, call it
 * inside a <Suspense> boundary in pages and layouts (ADR 0002, ADR 0004).
 */
export const getCurrentAuth = cache(async (): Promise<Authenticated | null> => resolveAuth(await currentHeaders()));

/**
 * The request's headers, with the cookies as they stand *now*. A Server Action
 * that has just replaced the session cookie (changing the password does) is
 * followed, in the same request, by a re-render of the page. `headers()` still
 * carries the cookie the request arrived with, which by then names a revoked
 * session; `cookies()` reflects what the action set. Without this, that
 * re-render would see the user as signed out.
 */
async function currentHeaders(): Promise<Headers> {
  const [incoming, jar] = await Promise.all([headers(), cookies()]);
  const merged = new Headers(incoming);
  const pairs = jar.getAll().map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`);
  if (pairs.length) merged.set("cookie", pairs.join("; "));
  else merged.delete("cookie");
  return merged;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  return (await getCurrentAuth())?.user ?? null;
}

/** Throws `Unauthenticated` (401) when there is no valid session. */
export function assertAuthenticated(auth: Authenticated | null): Authenticated {
  if (!auth) throw unauthenticated();
  return auth;
}

/** Throws `Forbidden` until the user has verified their email (plan §12: publishing, inviting, domains). */
export function assertVerified(user: AuthUser): AuthUser {
  if (!user.emailVerified) throw forbidden("Verify your email address to continue.");
  return user;
}

export async function requireAuth(): Promise<Authenticated> {
  return assertAuthenticated(await getCurrentAuth());
}

export async function requireUser(): Promise<AuthUser> {
  return (await requireAuth()).user;
}

export async function requireVerifiedUser(): Promise<AuthUser> {
  return assertVerified(await requireUser());
}

/**
 * For pages and layouts: the signed-in user, or a redirect to the login page
 * that returns to `next` afterwards. A cookie that no longer maps to a session
 * (expired, revoked, tampered) sends the user there with an explanation.
 *
 * This is the real check. The proxy's redirect only spares anonymous visitors
 * a round trip; it never decides access.
 */
export async function requireAuthOrLogin(next: string): Promise<Authenticated> {
  const auth = await getCurrentAuth();
  if (auth) return auth;
  const hadSession = findSessionCookie((await currentHeaders()).get("cookie")) !== null;
  redirect(loginPath({ next, reason: hadSession ? "session" : undefined }));
}

export async function requireUserOrLogin(next: string): Promise<AuthUser> {
  return (await requireAuthOrLogin(next)).user;
}

/**
 * For the screens meant for signed-out visitors (login, sign-up): someone who
 * is already signed in is sent on.
 *
 * Not while a Server Action is being handled. Signing in sets the cookie and
 * the page is re-rendered in the same request; redirecting from that render
 * would be a client-side transition that keeps the form (and the password
 * typed into it) mounted in the tab. The action leaves by itself, with a full
 * page load.
 */
export async function redirectIfSignedIn(to: string): Promise<void> {
  if ((await headers()).has("next-action")) return;
  if (await getCurrentUser()) redirect(to);
}

/** Who is acting, for request contexts, audit rows and logs. */
export function toActor(auth: Authenticated | null): Actor {
  return auth
    ? { kind: "user", userId: auth.user.id, sessionId: auth.session.id, emailVerified: auth.user.emailVerified }
    : ANONYMOUS;
}

export async function getCurrentActor(): Promise<Actor> {
  return toActor(await getCurrentAuth());
}
