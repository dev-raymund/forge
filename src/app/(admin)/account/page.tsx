import type { Metadata } from "next";
import { Suspense } from "react";
import { AppHeader } from "@/components/admin/app-header";
import {
  AccountSection, ChangePasswordForm, EmailStatus, listSessions, ProfileForm, requireAuthOrLogin, SessionList, SetPasswordPrompt,
  SignInMethodList, signInMethods, toActor, VerifyEmailBanner,
} from "@/modules/auth";
import { listOrganizations } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Account" };

/** The signed-in user's own account (plan §19): profile, password, sessions. */
export default function AccountPage() {
  return (
    <Suspense fallback={<AccountSkeleton />}>
      <Account />
    </Suspense>
  );
}

/** Request-time: the session. Everything shown belongs to the user that session identifies. */
async function Account() {
  const auth = await requireAuthOrLogin("/account");
  const { user } = auth;
  // The organizations are for the header's switcher: the way back from this page to one of them.
  const [sessions, methods, organizations] = await Promise.all([listSessions(auth), signInMethods(user.id), listOrganizations(toActor(auth))]);

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader user={user} organizations={organizations} />
      {user.emailVerified ? null : <VerifyEmailBanner />}
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="mb-8 text-2xl font-semibold tracking-tight">Account</h1>

        <AccountSection title="Profile" description="Your name is shown to people you work with in Forge.">
          <ProfileForm name={user.name} />
          <EmailStatus email={user.email} verified={user.emailVerified} />
        </AccountSection>

        <AccountSection title="Sign-in methods" description="How this account can log in.">
          <SignInMethodList password={methods.password} google={methods.google} />
        </AccountSection>

        <AccountSection title="Password">{methods.password ? <ChangePasswordForm email={user.email} /> : <SetPasswordPrompt />}</AccountSection>

        <AccountSection
          title="Sessions"
          description="Where your account is logged in. A session ends after 7 days without use, or 30 days after you logged in."
        >
          <SessionList
            sessions={sessions.map((session) => ({
              handle: session.handle,
              current: session.current,
              device: session.device,
              ipAddress: session.ipAddress,
              signedInAt: session.createdAt.toISOString(),
              lastActiveAt: session.lastActiveAt.toISOString(),
            }))}
          />
        </AccountSection>
      </main>
    </div>
  );
}

function AccountSkeleton() {
  return (
    <div aria-hidden="true" className="flex min-h-dvh flex-col">
      <div className="h-14 border-b" />
      <div className="mx-auto w-full max-w-3xl flex-1 animate-pulse px-4 py-10 motion-reduce:animate-none sm:px-6">
        <div className="h-7 w-40 rounded bg-muted" />
        <div className="mt-8 h-4 w-24 rounded bg-muted" />
        <div className="mt-4 h-10 max-w-sm rounded-lg bg-muted" />
        <div className="mt-10 h-4 w-24 rounded bg-muted" />
        <div className="mt-4 h-24 rounded-lg bg-muted" />
      </div>
    </div>
  );
}
