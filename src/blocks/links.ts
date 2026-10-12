/**
 * Where a link may point (plan §6.1): `http(s)`, `mailto`, `tel`, a site path
 * (`/about`, never `//host`), or one of the site's entries (`entry:{uuid}`).
 * Pure and client-safe; shared by the text marks, the button block, the
 * document's validation and the renderers.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export const LINK_MAX = 2_048;

export function isSafeHref(href: string): boolean {
  if (typeof href !== "string" || href.length === 0 || href.length > LINK_MAX) return false;
  if (href.startsWith("entry:")) return UUID.test(href.slice("entry:".length));
  if (href.startsWith("/")) return !href.startsWith("//") && !href.includes("\\");
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/** The entry an `entry:{id}` link names, or null for any other link. */
export const entryIdOf = (href: string): string | null => (href.startsWith("entry:") && UUID.test(href.slice(6)) ? href.slice(6).toLowerCase() : null);
