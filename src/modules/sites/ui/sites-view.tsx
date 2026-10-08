import { Globe, Plus } from "lucide-react";
import Link from "next/link";
import { FormAlert } from "@/components/admin/form";
import { countOf, hasRoomFor, limitMessage, PLANS, type Allowance } from "@/modules/billing/shared";
import { cn } from "@/lib/utils";
import { newSitePath, publicSitePath, sitePath } from "../paths";
import { SITE_STATUS_LABELS, type SiteStatus, type SiteSummary } from "../shared";

/**
 * An organization's sites (`/{orgSlug}/sites`, plan §19): a card for each,
 * and the way to create one for those who may. A server component: the page
 * decides what the member may do and passes the answer, never a role.
 */

const LINK = "rounded-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25";
const BUTTON =
  "inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-foreground/40";

const STATUS_TONES: Record<SiteStatus, string> = {
  coming_soon: "border-amber-700/30 bg-amber-50 text-amber-900",
  live: "border-emerald-700/30 bg-emerald-50 text-emerald-900",
  suspended: "border-destructive/40 bg-destructive/5 text-destructive",
};

export function SiteStatusBadge({ status }: { status: SiteStatus }) {
  return (
    <span data-testid="site-status" className={cn("inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium", STATUS_TONES[status])}>
      {SITE_STATUS_LABELS[status]}
    </span>
  );
}

export type SitesViewProps = {
  organization: { name: string; slug: string };
  /** The member's role, as a word, to say where they stand. */
  role: string;
  sites: SiteSummary[];
  /** Present only for a member who may create sites. */
  allowance: Allowance | null;
  notice?: "deleted";
};

export function SitesView({ organization, role, sites, allowance, notice }: SitesViewProps) {
  const canCreate = allowance !== null;
  const room = allowance ? hasRoomFor(allowance) : false;
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground" data-testid="organization-name">
            {organization.name}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Sites</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You are {/^[AEIOU]/.test(role) ? "an" : "a"} <span className="font-medium text-foreground" data-testid="member-role">{role}</span> of this organization.
          </p>
        </div>
        {canCreate && room && sites.length > 0 ? (
          <Link href={newSitePath(organization.slug)} className={BUTTON}>
            <Plus aria-hidden="true" className="size-4" />
            Create site
          </Link>
        ) : null}
      </div>

      {notice === "deleted" ? (
        <FormAlert tone="success" className="mt-6">
          The site has been deleted. Its address no longer shows it.
        </FormAlert>
      ) : null}

      {allowance ? (
        <p className="mt-6 text-sm text-muted-foreground" data-testid="site-allowance">
          {room
            ? `${allowance.used} of ${countOf("sites", allowance.limit)} on the ${PLANS[allowance.plan].label} plan.`
            : limitMessage(allowance)}
        </p>
      ) : null}

      {sites.length === 0 ? (
        <section aria-labelledby="no-sites-heading" className="mt-6 rounded-xl border border-dashed p-6 sm:p-8" data-testid="no-sites">
          <h2 id="no-sites-heading" className="text-base font-semibold tracking-tight">
            No sites yet
          </h2>
          {canCreate ? (
            <>
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">A site is a website you build and publish with Forge. Create the first one.</p>
              {room ? (
                <Link href={newSitePath(organization.slug)} className={cn(BUTTON, "mt-4")}>
                  <Plus aria-hidden="true" className="size-4" />
                  Create site
                </Link>
              ) : null}
            </>
          ) : (
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">An Owner or Admin of {organization.name} can create one.</p>
          )}
        </section>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Sites" data-testid="sites">
          {sites.map((site) => (
            <li key={site.id} className="grid gap-3 rounded-xl border p-5" data-testid="site">
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 text-base font-semibold tracking-tight wrap-anywhere">
                  <Link href={sitePath(organization.slug, site.slug)} className={LINK}>
                    {site.name}
                  </Link>
                </h2>
                <SiteStatusBadge status={site.status} />
              </div>
              {site.address ? (
                <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                  <Globe aria-hidden="true" className="size-4 shrink-0" />
                  {/* The public site: an ordinary link, never prefetched (it is another surface, ADR 0006). */}
                  <a href={publicSitePath(site.address)} className={cn(LINK, "truncate font-normal")} data-testid="site-address">
                    {publicSitePath(site.address)}
                  </a>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
