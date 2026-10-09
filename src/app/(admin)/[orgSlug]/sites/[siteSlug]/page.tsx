import type { Metadata } from "next";
import { Suspense } from "react";
import { Day } from "@/components/admin/local-day";
import { OrganizationSuspended } from "@/components/admin/page-notice";
import { PageSkeleton } from "@/components/admin/page-skeleton";
import { getSite, languageLabel, publicSitePath, sitePath, SiteStatusBadge } from "@/modules/sites";
import { requireSitePage } from "@/modules/tenancy";
import { activeThemeDefinition } from "@/themes/registry";

export const metadata: Metadata = { title: "Site" };

/**
 * A site's page in the admin (plan §19: `/{orgSlug}/sites/{siteSlug}`, every
 * member). For now: what the site is, its status and where the public sees it.
 * The overview proper (checklist, publishing, recent activity) is M4-2's.
 */
export default function SitePage({ params }: PageProps<"/[orgSlug]/sites/[siteSlug]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Site params={params} />
    </Suspense>
  );
}

async function Site({ params }: Pick<PageProps<"/[orgSlug]/sites/[siteSlug]">, "params">) {
  const { orgSlug, siteSlug } = await params;
  const access = await requireSitePage(orgSlug, siteSlug, sitePath);
  if (access.status === "suspended") return <OrganizationSuspended message={access.message} />;

  const site = await getSite(access.ctx);
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight wrap-anywhere" data-testid="site-name">
          {site.name}
        </h1>
        <SiteStatusBadge status={site.status} />
      </div>
      <dl className="mt-8 grid max-w-xl gap-x-6 gap-y-4 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">Public address</dt>
        <dd className="wrap-anywhere">
          {site.address ? (
            <a href={publicSitePath(site.address)} className="font-medium underline underline-offset-4 hover:no-underline" data-testid="site-address">
              {publicSitePath(site.address)}
            </a>
          ) : (
            "None"
          )}
        </dd>
        <dt className="text-muted-foreground">Theme</dt>
        <dd data-testid="site-theme">{activeThemeDefinition(site.theme).name}</dd>
        <dt className="text-muted-foreground">Language</dt>
        <dd data-testid="site-language">{languageLabel(site.language)}</dd>
        <dt className="text-muted-foreground">Time zone</dt>
        <dd data-testid="site-timezone">{site.timezone.replaceAll("_", " ")}</dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd>
          <Day iso={site.createdAt.toISOString()} />
        </dd>
      </dl>
    </main>
  );
}
