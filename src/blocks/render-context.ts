import { entryIdOf, isSafeHref } from "./links";

/**
 * What a block's renderer is told about the site it is drawn for (M5-5; the
 * public renderer gives it, M5-6): where the site's paths live, where an
 * `entry:{id}` link goes now, and which hosts may not be framed (the app's
 * own). Nothing else: a renderer reads no database and no session.
 */
export type BlockRenderContext = {
  /** The site's base for its own paths: `/s/{address}` in V1, "" on a site's own host later (ADR 0006). */
  basePath?: string;
  /** The public address of a live entry of this site, base included; undefined for anything else (a draft, the trash, another site's). */
  resolveEntryHref: (entryId: string) => string | undefined;
  blockedHosts?: readonly string[];
};

/** A path of the site under its base: `/` is the site's home (`/s/acme`, not `/s/acme/`). */
export function sitePath(basePath: string, path: string): string {
  if (path === "/") return basePath || "/";
  return `${basePath}${path}`;
}

/**
 * Where a stored link goes on the public site, or undefined when it may not be
 * drawn as a link: an unsafe address, or an `entry:` link to anything but a
 * live entry of this site. Site paths get the site's base; `http(s)`,
 * `mailto` and `tel` addresses are kept as they are.
 */
export function resolveHref(href: unknown, context: BlockRenderContext): string | undefined {
  if (typeof href !== "string" || !isSafeHref(href)) return undefined;
  const entryId = entryIdOf(href);
  if (entryId) return context.resolveEntryHref(entryId);
  if (href.startsWith("entry:")) return undefined;
  if (href.startsWith("/")) return sitePath(context.basePath ?? "", href);
  return href;
}
