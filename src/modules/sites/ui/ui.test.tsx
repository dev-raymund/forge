import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The forms import their Server Actions; rendering needs only their identity.
vi.mock("../actions", () => ({ createSiteAction: vi.fn(), changeSiteAddressAction: vi.fn(), deleteSiteAction: vi.fn() }));

import type { Allowance } from "@/modules/billing/shared";
import type { SiteSummary } from "../shared";
import { CreateSiteForm } from "./create-site-form";
import { DeleteSite, SiteAddressForm } from "./site-settings";
import { SitesView, type SitesViewProps } from "./sites-view";

const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const count = (markup: string, pattern: RegExp) => markup.match(pattern)?.length ?? 0;

const organization = { name: "Acme Studio", slug: "acme-studio" };
const site = (name: string, slug: string, address: string | null, status: SiteSummary["status"] = "coming_soon"): SiteSummary => ({
  id: `0199a000-0000-7000-8000-${slug.padStart(12, "0").slice(-12)}`, slug, name, status, address, language: "en", timezone: "UTC", createdAt: new Date("2026-10-01T00:00:00Z"),
});
const pro = (used: number): Allowance => ({ plan: "pro", key: "sites", used, limit: 5 });
const view = (props: Partial<SitesViewProps>) => html(<SitesView organization={organization} role="Owner" sites={[]} allowance={pro(0)} {...props} />);

describe("the sites page", () => {
  it("lists each site with its status and its public address, linking to its page", () => {
    const markup = view({ sites: [site("Bakery", "bakery", "acme-bakery"), site("Shop", "shop", "shop", "live")], allowance: pro(2) });
    expect(count(markup, /data-testid="site"/g)).toBe(2);
    expect(markup).toContain('href="/acme-studio/sites/bakery"');
    expect(markup).toContain('href="/s/acme-bakery"');
    expect(markup).toContain(">/s/acme-bakery<");
    expect(markup).toMatch(/data-testid="site-status"[^>]*>Coming soon</);
    expect(markup).toMatch(/data-testid="site-status"[^>]*>Live</);
    expect(markup).toContain("2 of 5 sites on the Pro plan.");
    expect(markup).toContain('href="/acme-studio/sites/new"');
  });

  it("someone who may create sites, with room: the way to create one, also when there are none yet", () => {
    const markup = view({ sites: [] });
    expect(markup).toContain('data-testid="no-sites"');
    expect(markup).toContain("Create the first one.");
    expect(count(markup, /href="\/acme-studio\/sites\/new"/g)).toBe(1);
  });

  it("the plan is full: no way to create one, and why", () => {
    const markup = view({ sites: [site("A", "a", "a"), site("B", "b", "b")], allowance: { plan: "free", key: "sites", used: 2, limit: 1 } });
    expect(markup).not.toContain("/sites/new");
    expect(markup).toContain("The Free plan includes 1 site, and this organization has reached it.");
  });

  it("someone who may not create sites sees the sites, and neither the way to create one nor the plan's figures", () => {
    const empty = view({ role: "Viewer", allowance: null });
    expect(empty).not.toContain("/sites/new");
    expect(empty).not.toContain('data-testid="site-allowance"');
    expect(empty).toContain("An Owner or Admin of Acme Studio can create one.");
    const some = view({ role: "Editor", allowance: null, sites: [site("Bakery", "bakery", "bakery")] });
    expect(some).not.toContain("/sites/new");
    expect(some).toContain('data-testid="site"');
    expect(some).toMatch(/data-testid="member-role"[^>]*>Editor</);
  });

  it("says when a site has just been deleted", () => {
    expect(view({ notice: "deleted" })).toContain("The site has been deleted.");
    expect(view({})).not.toContain("The site has been deleted.");
  });
});

describe("the site forms", () => {
  it("create: a labelled field for each of name, address, language and time zone, and the address it will have", () => {
    const markup = html(<CreateSiteForm orgSlug="acme-studio" timeZones={["UTC", "Asia/Manila", "America/New_York"]} />);
    for (const name of ["name", "address", "language", "timezone"]) expect(markup, name).toMatch(new RegExp(`name="${name}"`));
    expect(count(markup, /<label/g)).toBe(4);
    expect(markup).toContain("Your site will be at /s/your-site");
    expect(markup).toMatch(/<option value="fil">Filipino<\/option>/);
    expect(markup).toMatch(/<option value="America\/New_York">America\/New York<\/option>/);
    // Before the browser says where it is, UTC.
    expect(markup).toMatch(/<option value="UTC" selected="">UTC<\/option>/);
  });

  it("the address form shows the address the site has now; deleting starts with a button that opens the confirmation", () => {
    const address = html(<SiteAddressForm orgSlug="acme-studio" siteSlug="bakery" address="acme-bakery" />);
    expect(address).toContain('value="acme-bakery"');
    expect(address).toContain("Now: /s/acme-bakery.");
    const remove = html(<DeleteSite orgSlug="acme-studio" siteSlug="bakery" siteName="Bakery" confirmWith="acme-bakery" />);
    expect(remove).toContain("Delete site…");
    expect(remove).not.toContain('name="confirm"'); // the field exists only once the dialog is open
  });
});
