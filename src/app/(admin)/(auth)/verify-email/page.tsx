import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthCard, FormSkeleton, getCurrentUser, VerifyEmailPanel, verifyEmailView } from "@/modules/auth";
import { first, type SearchParams } from "../search-params";

export const metadata: Metadata = { title: "Verify your email" };

export default function VerifyEmailPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AuthCard title="Verify your email">
      <Suspense fallback={<FormSkeleton fields={1} />}>
        <VerifyEmail searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

/** The session decides what is shown; the query string only adds the outcome of a followed link. */
async function VerifyEmail({ searchParams }: { searchParams: SearchParams }) {
  const [query, user] = await Promise.all([searchParams, getCurrentUser()]);
  return <VerifyEmailPanel view={verifyEmailView(user, { error: first(query.error), status: first(query.status) })} />;
}
