import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountMenu, requireUserOrLogin, VerifyEmailBanner } from "@/modules/auth";

export const metadata: Metadata = { title: "Home" };

/**
 * The signed-in landing page. In M3 it becomes the redirect to the user's
 * last organization (or onboarding); until then it is the first protected
 * route: the header with the account menu, and the verification banner.
 */
export default function AdminHome() {
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <SignedInHome />
    </Suspense>
  );
}

/** Request-time: the session. Anything other than a valid session leaves for the login page. */
async function SignedInHome() {
  const user = await requireUserOrLogin("/");
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <p className="text-lg font-semibold tracking-tight">Forge</p>
          <AccountMenu name={user.name} email={user.email} />
        </div>
      </header>
      {user.emailVerified ? null : <VerifyEmailBanner />}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">Welcome, {user.name}</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          You are signed in as <span className="wrap-anywhere text-foreground">{user.email}</span>. Organizations and sites arrive next.
        </p>
      </main>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div aria-hidden="true" className="flex min-h-dvh flex-col">
      <div className="h-14 border-b" />
      <div className="mx-auto w-full max-w-5xl flex-1 animate-pulse px-4 py-10 motion-reduce:animate-none sm:px-6">
        <div className="h-7 w-56 rounded bg-muted" />
        <div className="mt-3 h-4 w-80 max-w-full rounded bg-muted" />
      </div>
    </div>
  );
}
