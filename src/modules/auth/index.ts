import "server-only";

/**
 * Public server API of the auth module. Other modules and app/ use these and
 * never Better Auth itself (D-07).
 */
export {
  getCurrentAuth, getCurrentUser, getCurrentActor, requireAuth, requireUser, requireVerifiedUser, requireUserOrLogin, requireAuthOrLogin, redirectIfSignedIn,
  assertAuthenticated, assertVerified, toActor, resolveAuth,
} from "./session";
export { authRouteHandlers, RESET_TOKEN_MINUTES } from "./auth";
export { googleSignInEnabled, turnstileSiteKey } from "./config";
export { oauthErrorMessage } from "./oauth";
export { authErrorToAppError, authFailureToAppError } from "./errors";
export { ANONYMOUS, MIN_PASSWORD_LENGTH } from "./shared";
export type { Actor, Authenticated, AuthSession, AuthUser } from "./shared";

// The account screens (M2-2). Pages in app/(admin) compose these; the forms
// call this module's Server Actions, which are the only way in.
export { AuthCard, AuthLink, FormSkeleton } from "./ui/auth-card";
export { LoginForm } from "./ui/login-form";
export { SignUpForm } from "./ui/signup-form";
export { ForgotPasswordForm } from "./ui/forgot-password-form";
export { ResetLinkInvalid, ResetPasswordForm } from "./ui/reset-password-form";
export { VerifyEmailPanel } from "./ui/verify-email-panel";
export { verifyEmailView } from "./verify-email-view";
export type { VerifyEmailView } from "./verify-email-view";
export { AccountMenu } from "./ui/account-menu";
export { VerifyEmailBanner } from "./ui/verify-email-banner";

// The account page (M2-4).
export { listSessions } from "./sessions.service";
export type { SessionSummary } from "./sessions.service";
export { signInMethods } from "./account.service";
export type { SignInMethods } from "./account.service";
export { AccountSection, EmailStatus, SignInMethodList } from "./ui/account-section";
export { ChangePasswordForm, ProfileForm, SessionList, SetPasswordPrompt } from "./ui/account-forms";
export type { SessionRow } from "./ui/account-forms";
