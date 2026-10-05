import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { canViewOrganizationSettings, orgSettingsPath, requireOrgPage, ROLE_LABELS } from "@/modules/tenancy";

export const metadata: Metadata = { title: "Overview" };

/**
 * An organization's home (`/{orgSlug}`). Until sites exist (M4-1, when this
 * becomes the redirect to `/{orgSlug}/sites`, plan §19) it says where the
 * member is and what they are there.
 */
export default function OrganizationHomePage({ params }: PageProps<"/[orgSlug]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <OrganizationHome params={params} />
    </Suspense>
  );
}

async function OrganizationHome({ params }: Pick<PageProps<"/[orgSlug]">, "params">) {
  const { orgSlug } = await params;
  const access = await requireOrgPage(orgSlug);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const { ctx } = access;
  const role = ROLE_LABELS[ctx.membership.role];
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-balance" data-testid="organization-name">
        {ctx.org.name}
      </h1>
      <p className="mt-2 text-muted-foreground">
        You are {/^[AEIOU]/.test(role) ? "an" : "a"} <span className="font-medium text-foreground" data-testid="member-role">{role}</span> of this organization.
      </p>

      <section aria-labelledby="sites-heading" className="mt-10 rounded-xl border border-dashed p-6 sm:p-8">
        <h2 id="sites-heading" className="text-base font-semibold tracking-tight">
          Sites
        </h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">Sites are what you build and publish with Forge. Creating and managing them from here comes next.</p>
      </section>

      {canViewOrganizationSettings(ctx) ? (
        <p className="mt-6 text-sm">
          <Link
            href={orgSettingsPath(ctx.org.slug)}
            className="rounded-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25"
          >
            Organization settings
          </Link>
        </p>
      ) : null}
    </main>
  );
}
