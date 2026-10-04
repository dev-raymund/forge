import Link from "next/link";
import { AccountMenu } from "@/modules/auth";

/**
 * The top bar of every signed-in admin page: the wordmark and the account
 * menu. M3 adds the organization switcher next to the wordmark.
 */
export function AppHeader({ user }: { user: { name: string; email: string } }) {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="rounded-sm text-lg font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-foreground/25">
          Forge
        </Link>
        <AccountMenu name={user.name} email={user.email} />
      </div>
    </header>
  );
}
