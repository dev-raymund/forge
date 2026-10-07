import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard, AuthLink, FormSkeleton, googleSignInEnabled, LoginForm, oauthErrorMessage, redirectIfSignedIn } from "@/modules/auth";
import { isLoginReason, safeNextPath } from "@/platform/routing/admin-access";
import { first, type SearchParams } from "../search-params";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AuthCard
      title="Log in to Forge"
      description="Enter your email and password to continue."
      footer={
        <>
          New to Forge? <AuthLink href="/signup">Create an account</AuthLink>
        </>
      }
    >
      <Suspense fallback={<FormSkeleton fields={2} />}>
        <Login searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

/** Request-time: the destination from the query string, and whether there is already a session. */
async function Login({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const next = safeNextPath(first(query.next)); // untrusted: only a path on this app survives
  await redirectIfSignedIn(next);
  const reason = first(query.reason);
  return (
    <LoginForm
      next={next}
      reason={isLoginReason(reason) ? reason : undefined}
      googleEnabled={googleSignInEnabled()}
      // A Google sign-in that failed comes back here with `?error=<code>`; only our own wording is shown.
      oauthError={oauthErrorMessage(first(query.error))}
      // Only a starting value for the field (an invitation's address). Logging in still takes the password.
      email={(first(query.email) ?? "").slice(0, 254)}
    />
  );
}
