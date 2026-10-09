import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The forms import their Server Actions; rendering needs only their identity.
vi.mock("../actions", () => ({ createSiteAction: vi.fn(), changeSiteAddressAction: vi.fn(), deleteSiteAction: vi.fn(), chooseThemeAction: vi.fn() }));

import type { Allowance } from "@/modules/billing/shared";
import type { SiteSummary } from "../shared";
import { CreateSiteForm } from "./create-site-form";
import { DeleteSite, SiteAddressForm } from "./site-settings";
import { SitesView, type SitesViewProps } from "./sites-view";
import { ThemePicker } from "./theme-picker";
import { THEMES } from "@/themes/registry";

const html = (node: React.ReactNode) => renderToStaticMarkup(node);
const count = (markup: string, pattern: RegExp) => markup.match(pattern)?.length ?? 0;

const organization = { name: "Acme Studio", slug: "acme-studio" };
const site = (name: string, slug: string, address: string | null, status: SiteSummary["status"] = "coming_soon"): SiteSummary => ({
  id: `0199a000-0000-7000-8000-${slug.padStart(12, "0").slice(-12)}`, slug, name, status, address, language: "en", timezone: "UTC", theme: "studio",
  createdAt: new Date("2026-10-01T00:00:00Z"),
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

describe("the theme picker (M4-4)", () => {
  const themes = THEMES.map(({ key, name, description, preview, defaults }) => ({ key, name, description, preview, colors: defaults.tokens.colors }));
  const picker = (active: string) => html(<ThemePicker orgSlug="acme-studio" siteSlug="bakery" themes={themes} active={active} />);

  it("offers every theme of the registry as a radio, with its name, description and sketch", () => {
    const markup = picker("studio");
    const radios = markup.match(/<input type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    for (const radio of radios) expect(radio).toContain('name="theme"');
    expect(markup).toMatch(/value="studio"/);
    expect(markup).toMatch(/value="journal"/);
    for (const theme of themes) {
      expect(markup).toContain(`>${theme.name}<`);
      expect(markup).toContain(theme.description);
      expect(markup).toContain(`id="theme-${theme.key}-description"`);
    }
    expect(count(markup, /data-testid="theme-thumbnail"/g)).toBe(2);
    expect(markup).toContain("<legend");
    expect(markup).toContain("Use this theme");
  });

  it("the site's theme is the one checked, and the only one marked current", () => {
    for (const active of ["studio", "journal"]) {
      const markup = picker(active);
      expect(count(markup, /data-testid="current-theme"/g)).toBe(1);
      expect(markup).toMatch(new RegExp(`data-theme-key="${active}"[^]*?Current theme`));
      const checked = (markup.match(/<input type="radio"[^>]*>/g) ?? []).filter((radio) => radio.includes('checked=""'));
      expect(checked).toHaveLength(1);
      expect(checked[0]).toContain(`value="${active}"`);
    }
  });

  it("the sketches are decorative, drawn from each theme's own default colours", () => {
    const markup = picker("studio");
    expect(count(markup, /data-testid="theme-thumbnail"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-testid="theme-thumbnail"/g)).toBe(2);
    expect(markup).toContain("background:#ffffff");
    expect(markup).toContain("background:#fffdf8");
  });
});
