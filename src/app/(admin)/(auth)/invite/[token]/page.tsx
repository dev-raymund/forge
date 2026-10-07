import type { Metadata } from "next";
import { Suspense } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { AuthCard, AuthLink, FormSkeleton, getCurrentUser, SwitchAccountButton } from "@/modules/auth";
import { AcceptInvitationForm, acceptInvitationAction, INVITATION_DAYS, invitationPath, isInvitedAccount, previewInvitation } from "@/modules/tenancy";
import { ROLE_LABELS } from "@/modules/tenancy/shared";

// The address of this page is the secret: it is never to travel in a Referer header.
export const metadata: Metadata = { title: "Invitation", referrer: "no-referrer" };

/**
 * Where an invitation link leads (plan §19). The link shows that the visitor
 * received the invitation, and that is all it shows: joining takes an account
 * whose own email address is the one that was invited.
 *
 *   not signed in            → create an account, or log in, and come back here
 *   signed in, same address  → "Accept invitation"
 *   signed in, other address → said so, with a way to switch accounts
 *
 * A link that cannot be accepted any more (used, revoked, expired, unknown)
 * names no organization and nobody's address.
 */
export default function InvitationPage({ params }: PageProps<"/invite/[token]">) {
  return (
    <Suspense
      fallback={
        <AuthCard title="Invitation">
          <FormSkeleton fields={1} />
        </AuthCard>
      }
    >
      <Invitation params={params} />
    </Suspense>
  );
}

const withArticle = (word: string) => `${/^[AEIOU]/.test(word) ? "an" : "a"} ${word}`;

async function Invitation({ params }: Pick<PageProps<"/invite/[token]">, "params">) {
  const { token } = await params;
  const [invitation, user] = await Promise.all([previewInvitation(token), getCurrentUser()]);

  if (invitation.status !== "open") {
    const expired = invitation.status === "expired";
    return (
      <AuthCard title={expired ? "This invitation has expired" : "This invitation is not valid"} footer={<AuthLink href="/">Go to Forge</AuthLink>}>
        <p className="text-sm text-muted-foreground" data-testid="invitation-state" data-state={invitation.status}>
          {expired
            ? `Invitations work for ${INVITATION_DAYS} days. Ask the person who invited you to send a new one.`
            : "This link does not work any more. It may have been used already, or withdrawn. Ask the person who invited you to send a new one."}
        </p>
      </AuthCard>
    );
  }

  const here = invitationPath(token);
  const query = `next=${encodeURIComponent(here)}&email=${encodeURIComponent(invitation.email)}`;
  const role = ROLE_LABELS[invitation.role];
  return (
    <AuthCard
      title={`Join ${invitation.organizationName} on Forge`}
      description={`${invitation.inviterName ?? "A teammate"} invited you to join ${invitation.organizationName} as ${withArticle(role)}.`}
    >
      <div className="grid gap-4" data-testid="invitation-state" data-state="open">
        <p className="text-sm text-muted-foreground">
          This invitation was sent to <span className="wrap-anywhere font-medium text-foreground">{invitation.email}</span>.
        </p>

        {!user ? (
          <>
            <p className="text-sm text-muted-foreground">To accept it, use a Forge account with that email address.</p>
            <Button asChild className="h-10 w-full focus-visible:ring-foreground/40">
              <a href={`/signup?${query}`}>Create an account</a>
            </Button>
            <Button asChild variant="outline" className="h-10 w-full focus-visible:ring-foreground/40">
              <a href={`/login?${query}`}>Log in</a>
            </Button>
          </>
        ) : isInvitedAccount(invitation.email, user.email) ? (
          <AcceptInvitationForm action={acceptInvitationAction.bind(null, token)} />
        ) : (
          <>
            <FormAlert tone="info">
              You are logged in as <span className="wrap-anywhere font-medium">{user.email}</span>. This invitation is for a different address, so this account
              cannot accept it.
            </FormAlert>
            <SwitchAccountButton then={`/login?${query}`}>Log in with another account</SwitchAccountButton>
          </>
        )}
      </div>
    </AuthCard>
  );
}
