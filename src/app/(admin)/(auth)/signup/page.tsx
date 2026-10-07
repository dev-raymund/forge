import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard, AuthLink, FormSkeleton, googleSignInEnabled, redirectIfSignedIn, SignUpForm, turnstileSiteKey } from "@/modules/auth";
import { safeNextPath } from "@/platform/routing/admin-access";
import { first, type SearchParams } from "../search-params";

export const metadata: Metadata = { title: "Sign up" };

export default function SignUpPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AuthCard
      title="Create your Forge account"
      description="Build and publish websites for your organization."
      footer={
        <>
          Already have an account? <AuthLink href="/login">Log in</AuthLink>
        </>
      }
    >
      <Suspense fallback={<FormSkeleton fields={3} />}>
        <SignUp searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

/** Request-time: where to continue afterwards and an address to start with (both from an invitation), and whether there is already a session. */
async function SignUp({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const next = safeNextPath(first(query.next)); // untrusted: only a path on this app survives
  await redirectIfSignedIn(next);
  // Only ever a starting value for the field. Who the account belongs to is decided by Better Auth, from what is submitted.
  const email = (first(query.email) ?? "").slice(0, 254);
  return <SignUpForm turnstileSiteKey={turnstileSiteKey()} googleEnabled={googleSignInEnabled()} next={next} email={email} />;
}
