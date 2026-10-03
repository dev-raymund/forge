import { Info } from "lucide-react";
import { AuthLink } from "./auth-card";

/** Shown across the admin until the signed-in user's address is verified (plan §12). */
export function VerifyEmailBanner() {
  return (
    <div role="status" data-testid="verify-email-banner" className="border-b bg-muted">
      <p className="mx-auto flex max-w-5xl items-start gap-2 px-4 py-2.5 text-sm sm:px-6">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          Verify your email address to publish sites and invite people. <AuthLink href="/verify-email">Verify email</AuthLink>
        </span>
      </p>
    </div>
  );
}
