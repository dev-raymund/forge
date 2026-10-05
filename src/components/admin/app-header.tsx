import Link from "next/link";
import { AccountMenu } from "@/modules/auth";
import { OrgSwitcher, orgPath } from "@/modules/tenancy";

/**
 * The top bar of every signed-in admin page: the wordmark, the organization
 * switcher (once the user belongs to one) and the account menu.
 *
 * `currentSlug` is the organization in the page's URL, when there is one. The
 * header shows it; it does not decide it.
 */
export function AppHeader({
  user, organizations = [], currentSlug,
}: {
  user: { name: string; email: string };
  organizations?: { slug: string; name: string; status: "active" | "suspended" }[];
  currentSlug?: string;
}) {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
        <Link
          href={currentSlug ? orgPath(currentSlug) : "/"}
          className="rounded-sm text-lg font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-foreground/25"
        >
          Forge
        </Link>
        {organizations.length > 0 ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground/60">
              /
            </span>
            <OrgSwitcher
              organizations={organizations.map(({ slug, name, status }) => ({ slug, name, suspended: status === "suspended" }))}
              currentSlug={currentSlug}
            />
          </>
        ) : null}
        <div className="ml-auto shrink-0">
          <AccountMenu name={user.name} email={user.email} />
        </div>
      </div>
    </header>
  );
}
