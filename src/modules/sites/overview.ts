/**
 * A site's launch checklist (M4-2; plan §3: "the product's onboarding spine:
 * add pages, add a menu, set SEO, connect a domain, publish"). Pure: each item
 * is done or not from what the database holds, never assumed. An item whose
 * screen does not exist yet says so, and links nowhere.
 */

export type ChecklistFacts = {
  publishedPages: number;
  menusWithItems: number;
  seoConfigured: boolean;
  hasAddress: boolean;
  status: string;
};

export type ChecklistItem = {
  key: "pages" | "menu" | "seo" | "domain" | "publish";
  label: string;
  done: boolean;
  /** Where to do it, when that screen exists. */
  href?: string;
  /** What the person should know: how it is done, or that it is not available yet. */
  note: string;
};

const LATER = "Not available yet.";

export function launchChecklist(facts: ChecklistFacts, paths: { settings: string; publicSite: string | null }): ChecklistItem[] {
  return [
    {
      key: "pages",
      label: "Add your pages",
      done: facts.publishedPages > 0,
      note: facts.publishedPages > 0 ? `${facts.publishedPages} published ${facts.publishedPages === 1 ? "page" : "pages"}.` : LATER,
    },
    { key: "menu", label: "Set up your menu", done: facts.menusWithItems > 0, note: facts.menusWithItems > 0 ? "Your menu is set up." : LATER },
    { key: "seo", label: "Set up search engine details", done: facts.seoConfigured, note: facts.seoConfigured ? "Set." : LATER },
    {
      key: "domain",
      label: "Your site's address",
      done: facts.hasAddress,
      ...(facts.hasAddress ? { href: paths.settings } : {}),
      note: facts.hasAddress && paths.publicSite ? `Visitors find it at ${paths.publicSite}.` : "The site has no address.",
    },
    {
      key: "publish",
      label: "Publish your site",
      done: facts.status === "live",
      note: facts.status === "live" ? "Your site is live." : facts.status === "suspended" ? "The site is unavailable." : LATER,
    },
  ];
}

/** What a status means to the people who run the site. Nothing about why a site is suspended. */
export const STATUS_EXPLANATIONS: Readonly<Record<string, string>> = {
  coming_soon: "Visitors see a Coming soon page, and search engines are asked not to list the site.",
  live: "The site is published: visitors see your site.",
  suspended: "The site is unavailable to visitors.",
};
