import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard, AuthLink, FormSkeleton, googleSignInEnabled, redirectIfSignedIn, SignUpForm, turnstileSiteKey } from "@/modules/auth";

export const metadata: Metadata = { title: "Sign up" };

export default function SignUpPage() {
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
        <SignUp />
      </Suspense>
    </AuthCard>
  );
}

async function SignUp() {
  await redirectIfSignedIn("/");
  return <SignUpForm turnstileSiteKey={turnstileSiteKey()} googleEnabled={googleSignInEnabled()} />;
}
