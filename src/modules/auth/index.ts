import "server-only";

/**
 * Public server API of the auth module. Other modules and app/ use these and
 * never Better Auth itself (D-07).
 */
export {
  getCurrentAuth, getCurrentUser, getCurrentActor, requireAuth, requireUser, requireVerifiedUser,
  assertAuthenticated, assertVerified, toActor, resolveAuth,
} from "./session";
export { authRouteHandlers } from "./auth";
export { authErrorToAppError } from "./errors";
export { ANONYMOUS, MIN_PASSWORD_LENGTH } from "./shared";
export type { Actor, Authenticated, AuthSession, AuthUser } from "./shared";
