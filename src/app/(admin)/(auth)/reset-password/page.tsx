import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard, AuthLink, FormSkeleton, ResetLinkInvalid, ResetPasswordForm } from "@/modules/auth";
import { first, type SearchParams } from "../search-params";

export const metadata: Metadata = {
  title: "Choose a new password",
  // The address of this page carries the reset token: never send it on as a referrer.
  referrer: "no-referrer",
};

export default function ResetPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AuthCard
      title="Choose a new password"
      footer={
        <>
          <AuthLink href="/login">Back to log in</AuthLink>
        </>
      }
    >
      <Suspense fallback={<FormSkeleton fields={1} />}>
        <ResetPassword searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

/**
 * Better Auth checks the emailed link and redirects here with `?token=` when
 * it is usable, or `?error=` when it is not. The token is checked again, and
 * consumed, when the form is submitted.
 */
async function ResetPassword({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const token = first(query.token);
  if (!token || first(query.error)) return <ResetLinkInvalid />;
  return <ResetPasswordForm token={token} />;
}
