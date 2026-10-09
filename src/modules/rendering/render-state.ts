/**
 * What a public request renders (M4-3, ADR 0013). Pure: the site's status and
 * the path decide, and nothing about the visitor does.
 *
 *   no site at the address      site-not-found     404   the platform's page
 *   suspended                   site-unavailable   404   the platform's page, nothing of the site
 *   coming_soon, any path       coming-soon        200   the theme's page, noindex
 *   live, the home page         home               200   the theme's page template
 *   live, any other path        page-not-found     404   the theme's not-found template
 *
 * A live site has no pages yet: routes to content arrive with M5-6
 * (`resolveRoute`). Until then its home page is the theme's page template with
 * the site's name, and every other path is not found.
 */

export type RenderState =
  | { kind: "site-not-found" }
  | { kind: "site-unavailable" }
  | { kind: "coming-soon" }
  | { kind: "home" }
  | { kind: "page-not-found" };

export type RenderStateKind = RenderState["kind"];

/** The statuses the renderer knows (`sites.status`). Anything else is treated as unavailable: closed, not open. */
const RENDERABLE = new Set(["coming_soon", "live"]);

/** Whether a site can be shown at all: it exists, and is coming soon or live. Its theme then draws every page of it. */
export const isShowable = (site: { status: string } | null): boolean => site !== null && RENDERABLE.has(site.status);

export function renderStateFor(site: { status: string } | null, path: readonly string[] = []): RenderState {
  if (!site) return { kind: "site-not-found" };
  if (!RENDERABLE.has(site.status)) return { kind: "site-unavailable" };
  if (site.status === "coming_soon") return { kind: "coming-soon" };
  return path.length === 0 ? { kind: "home" } : { kind: "page-not-found" };
}

/** The HTTP status each state answers with. 404s come from `notFound()`, thrown before anything streams. */
export const HTTP_STATUS: Readonly<Record<RenderStateKind, 200 | 404>> = {
  "site-not-found": 404,
  "site-unavailable": 404,
  "coming-soon": 200,
  home: 200,
  "page-not-found": 404,
};


/**
 * Robots for each state (plan §10: "forced noindex for coming-soon sites").
 * Only a live site's real page may be indexed. Next also marks every 404
 * response `noindex` by itself; the states that answer 404 say so here too.
 */
export function robotsFor(kind: RenderStateKind): { index: boolean; follow: boolean } {
  return kind === "home" ? { index: true, follow: true } : { index: false, follow: false };
}
