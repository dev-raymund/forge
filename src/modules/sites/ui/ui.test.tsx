import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The forms import their Server Actions; rendering needs only their identity.
vi.mock("../actions", () => ({
  createSiteAction: vi.fn(), changeSiteAddressAction: vi.fn(), deleteSiteAction: vi.fn(), chooseThemeAction: vi.fn(), updateSiteSettingsAction: vi.fn(),
  setSiteStatusAction: vi.fn(),
}));

import type { Allowance } from "@/modules/billing/shared";
import type { SiteSummary } from "../shared";
import { CreateSiteForm } from "./create-site-form";
import { DeleteSite, SiteAddressForm } from "./site-settings";
import { SitesView, type SitesViewProps } from "./sites-view";
import { ThemePicker } from "./theme-picker";
import { launchChecklist } from "../overview";
import type { SiteOverview } from "../overview.service";
import { SiteOverviewView } from "./site-overview";
import { AnalyticsSettingsForm, GeneralSettingsForm, ReadingSettingsForm } from "./site-settings-forms";
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

describe("the site overview (M4-2)", () => {
  const overview = (over: Partial<SiteOverview> = {}): SiteOverview => ({
    site: site("Bakery", "bakery", "acme-bakery"),
    publicUrl: "https://cms.forgelinetechnologies.com/s/acme-bakery",
    theme: { key: "journal", name: "Journal" },
    tagline: "Fresh daily",
    reading: { blogPath: "news", postsPerPage: 12 },
    analytics: { ga4: true, plausible: false },
    socialLinks: 1,
    checklist: launchChecklist({ publishedPages: 0, menusWithItems: 0, seoConfigured: false, hasAddress: true, status: "coming_soon" }, { settings: "/acme-studio/sites/bakery/settings", publicSite: "/s/acme-bakery" }),
    ...over,
  });
  type RenderProps = { canManage?: boolean; emailVerified?: boolean; activity?: { id: string; sentence: string; occurredAt: string }[] | null; overview?: SiteOverview };
  const render = (props: RenderProps = {}) =>
    html(
      <SiteOverviewView
        orgSlug="acme-studio"
        overview={props.overview ?? overview()}
        canManage={props.canManage ?? true}
        emailVerified={props.emailVerified ?? true}
        activity={props.activity ?? null}
        activityHref="/acme-studio/activity?site=x"
      />,
    );
  const withStatus = (status: SiteSummary["status"]) =>
    overview({
      site: site("Bakery", "bakery", "acme-bakery", status),
      checklist: launchChecklist(
        { publishedPages: 0, menusWithItems: 0, seoConfigured: false, hasAddress: true, status },
        { settings: "/acme-studio/sites/bakery/settings", publicSite: "/s/acme-bakery", publish: "#publish" },
      ),
    });

  it("says the site's status, what it means, its public address and its theme", () => {
    const markup = render();
    expect(markup).toMatch(/data-testid="site-status"[^>]*>Coming soon</);
    expect(markup).toContain("Visitors see a Coming soon page");
    expect(markup).toMatch(/href="https:\/\/cms\.forgelinetechnologies\.com\/s\/acme-bakery"[^>]*data-testid="site-address"[^>]*>https:\/\/cms\.forgelinetechnologies\.com\/s\/acme-bakery</);
    expect(markup).toMatch(/data-testid="site-theme"[^>]*>Journal</);
    expect(markup).toContain("Blog at <span class=\"font-medium\">/news</span>, 12 posts a page");
    expect(markup).toMatch(/data-testid="site-analytics"[^>]*>Google Analytics 4</);
    expect(markup).toContain("Saved; tracking is not active yet.");
  });

  it("the checklist: five items, the address done and linked, the rest not available yet", () => {
    const markup = render();
    expect(count(markup, /data-testid="checklist-item"/g)).toBe(5);
    expect(count(markup, /data-done=""/g)).toBe(1);
    expect(markup).toContain("1 of 5 done.");
    expect(count(markup, /Not available yet\./g)).toBe(3);
    expect(markup).toContain("When you publish, visitors see your site instead of the Coming soon page.");
  });

  it("publishing (M4-5): a Coming soon site offers Publish, a live one the way back and a link to it", () => {
    const comingSoon = render({ overview: withStatus("coming_soon") });
    expect(comingSoon).toContain('id="publish"');
    expect(comingSoon).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>.*Publish site…<\/button>/);
    expect(comingSoon).not.toContain("Switch to Coming soon");
    expect(comingSoon).toMatch(/href="#publish"[^>]*>Publish your site</);

    const live = render({ overview: withStatus("live") });
    expect(live).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Switch to Coming soon…<\/button>/);
    expect(live).not.toContain("Publish site…");
    expect(live).toMatch(/href="https:\/\/cms\.forgelinetechnologies\.com\/s\/acme-bakery"[^>]*data-testid="view-site"/);
    expect(live).toContain("visitors see its home page, and search engines may list it");
    expect(live).toContain("Your site is live.");
  });

  it("publishing: nothing for those who may not, nothing for a suspended site, and a verified email address first", () => {
    for (const markup of [render({ canManage: false, overview: withStatus("coming_soon") }), render({ canManage: false, overview: withStatus("live") })]) {
      expect(markup).not.toContain('data-testid="site-publishing"');
      expect(markup).not.toContain("Publish site…");
    }
    const suspended = render({ overview: withStatus("suspended") });
    expect(suspended).not.toContain('data-testid="site-publishing"');
    expect(suspended).toContain("The site is unavailable.");

    const unverified = render({ emailVerified: false, overview: withStatus("coming_soon") });
    expect(unverified).toContain("Verify your email address to publish this site.");
    expect(unverified).toContain('href="/verify-email"');
    expect(unverified).not.toContain("Publish site…");
    // Switching back to Coming soon hides the site: it does not wait for the address to be verified.
    expect(render({ emailVerified: false, overview: withStatus("live") })).toContain("Switch to Coming soon…");
  });

  it("links to change things only for those who may; recent activity only for those who may read the log", () => {
    expect(count(render({ canManage: true }), />Change</g)).toBe(5);
    expect(render({ canManage: false })).not.toContain(">Change<");
    expect(render()).not.toContain("Recent activity");
    const withActivity = render({ activity: [{ id: "1", sentence: "Ada created the site Bakery at /s/acme-bakery.", occurredAt: "2026-10-01T00:00:00.000Z" }] });
    expect(withActivity).toContain("Recent activity");
    expect(withActivity).toContain("Ada created the site Bakery at /s/acme-bakery.");
    expect(withActivity).toContain('href="/acme-studio/activity?site=x"');
  });
});

describe("the settings forms (M4-2)", () => {
  const bound = { orgSlug: "acme-studio", siteSlug: "bakery", version: 7 };

  it("each carries the version it was rendered with", () => {
    const forms = [
      html(<GeneralSettingsForm {...bound} timeZones={["UTC"]} values={{ name: "Bakery", tagline: "", language: "en", timezone: "UTC" }} />),
      html(<ReadingSettingsForm {...bound} address="acme-bakery" values={{ blogPath: "blog", postsPerPage: 10 }} />),
      html(<AnalyticsSettingsForm {...bound} values={{ ga4MeasurementId: "", plausibleDomain: "" }} />),
    ];
    for (const markup of forms) expect(markup).toMatch(/<input type="hidden" name="version" value="7"\/>/);
  });

  it("general: name, tagline, language, time zone, and a field for each social network", () => {
    const markup = html(<GeneralSettingsForm {...bound} timeZones={["UTC", "Asia/Manila"]} values={{ name: "Bakery", tagline: "Fresh", language: "fil", timezone: "Asia/Manila", instagram: "https://instagram.com/b" }} />);
    for (const field of ["name", "tagline", "language", "timezone", "facebook", "instagram", "x", "linkedin", "youtube", "tiktok"]) expect(markup, field).toMatch(new RegExp(`name="${field}"`));
    expect(markup).toContain('value="https://instagram.com/b"');
    expect(markup).toContain("<legend");
  });

  it("reading says it takes effect once the site has posts; analytics that tracking is not active, and only two services will be offered", () => {
    expect(html(<ReadingSettingsForm {...bound} address="acme-bakery" values={{ blogPath: "news", postsPerPage: 10 }} />)).toContain("Your posts will be at /s/acme-bakery/news.");
    expect(html(<ReadingSettingsForm {...bound} address="a" values={{ blogPath: "blog", postsPerPage: 10 }} />)).toContain("nothing on the site uses them");
    const analytics = html(<AnalyticsSettingsForm {...bound} values={{ ga4MeasurementId: "G-ABC1234567", plausibleDomain: "" }} />);
    expect(analytics).toContain("no other code can be added.");
    // M4-5: saved and validated, never emitted until consent is supported (ADR 0015 §6).
    expect(analytics).toContain("Tracking is not active yet");
  });
});
