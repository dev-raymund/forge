import { CircleAlert, CircleCheck } from "lucide-react";
import { useId } from "react";
import { AuthLink } from "./auth-card";

/** One block of the account page: a heading, an optional line of explanation, the content. */
export function AccountSection({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-4 border-t py-8 first:border-t-0 first:pt-0">
      <div className="grid gap-1">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {description ? <p className="max-w-prose text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** The address cannot be changed in V1; it is shown with whether it has been verified. */
export function EmailStatus({ email, verified }: { email: string; verified: boolean }) {
  return (
    <dl className="grid max-w-sm gap-1 text-sm">
      <dt className="font-medium">Email</dt>
      <dd className="wrap-anywhere" data-testid="account-email">
        {email}
      </dd>
      <dd className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="account-email-status" data-verified={verified}>
        {verified ? (
          <span className="inline-flex items-center gap-1.5 text-emerald-800">
            <CircleCheck aria-hidden="true" className="size-4" /> Verified
          </span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <CircleAlert aria-hidden="true" className="size-4" /> Not verified
            </span>
            <AuthLink href="/verify-email">Verify email</AuthLink>
          </>
        )}
      </dd>
    </dl>
  );
}

/** How the account can sign in. Read-only: methods cannot be added or removed here in V1. */
export function SignInMethodList({ password, google }: { password: boolean; google: boolean }) {
  const rows = [
    { name: "Password", on: password, yes: "Set", no: "Not set" },
    { name: "Google", on: google, yes: "Connected", no: "Not connected" },
  ];
  return (
    <ul className="grid max-w-sm gap-2 text-sm" data-testid="sign-in-methods">
      {rows.map((row) => (
        <li key={row.name} data-method={row.name.toLowerCase()} data-on={row.on} className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
          <span className="font-medium">{row.name}</span>
          <span className={row.on ? "text-foreground" : "text-muted-foreground"}>{row.on ? row.yes : row.no}</span>
        </li>
      ))}
    </ul>
  );
}
