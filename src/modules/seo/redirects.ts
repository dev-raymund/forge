/**
 * Redirects (M8-5; plan §10; cms-architecture §17.3, D-20 simplified to exact match; ADR 0032). Pure and client-safe:
 * the address rules, the status codes, loop detection and chain flattening. The services (./redirects.service.ts) and
 * the public site (rendering) use the same functions.
 *
 *   source        a path of the site, as visitors type it: matched exactly, after percent-decoding (as Next decodes a
 *                 request's segments); no query, no fragment, no trailing slash, no `.`/`..`, no encoded `/`
 *   destination   a path of the site (as a source, `/` allowed), or an absolute http(s) address elsewhere
 *   status        301, 302, 307 or 308 (DB CHECK); permanent (301, 308) or temporary (302, 307)
 *
 * Chains are flattened when written, so a visitor is sent at most one hop: writing A→B while B→C exists stores A→C,
 * and writing B→C while A→B exists rewrites A→C. Following a destination through the site's redirects that comes back
 * to the source, or takes more than ten steps, is refused.
 */

export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];
/** What a path change makes (plan §10 "Auto 301"), and what a new redirect is unless another code is chosen. */
export const AUTO_REDIRECT_STATUS: RedirectStatus = 301;
export const DEFAULT_REDIRECT_STATUS: RedirectStatus = 301;

export const REDIRECT_STATUS_LABELS: Readonly<Record<RedirectStatus, string>> = {
  301: "301 · Moved permanently",
  308: "308 · Permanent redirect",
  302: "302 · Found (temporary)",
  307: "307 · Temporary redirect",
};

export const isRedirectStatus = (value: unknown): value is RedirectStatus => typeof value === "number" && (REDIRECT_STATUSES as readonly number[]).includes(value);
export const isPermanent = (status: RedirectStatus): boolean => status === 301 || status === 308;

/**
 * What a visitor's browser is sent. A page of the App Router can answer 307 or 308 (the method-keeping pair) and
 * nothing else; site pages answer GET and HEAD only, where 301 and 308 mean the same, as do 302 and 307. So a
 * permanent redirect is sent as 308 and a temporary one as 307 (ADR 0032 §5).
 */
export const responseStatusOf = (status: RedirectStatus): 307 | 308 => (isPermanent(status) ? 308 : 307);

/** Steps followed before a chain is called too long (plan §10 "loop detection (depth 10)"). */
export const REDIRECT_DEPTH_MAX = 10;
/** A site's redirects, at most. Past it, new ones made by hand are refused; path changes still make theirs. */
export const REDIRECTS_MAX = 10_000;
/** As the public routes (rendering/routes.ts): a path longer or deeper names nothing there. */
export const REDIRECT_PATH_MAX = 1_024;
export const REDIRECT_SEGMENTS_MAX = 16;
export const REDIRECT_URL_MAX = 2_048;

/** Forge's own addresses on every site (as content's `RESERVED_PATHS`): never a source. */
export const RESERVED_REDIRECT_PATHS: readonly string[] = ["/_forge", "/sitemap.xml", "/robots.txt"];
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };
const refuse = <T>(message: string): Parsed<T> => ({ ok: false, message });

// Control characters, whitespace other than a space, and the characters that are never part of a path as Forge keeps it.
const FORBIDDEN = /[\u0000-\u001f\u007f\\<>"`]|[\u2028\u2029]/;

/**
 * A path of the site as Forge keeps it: percent-decoded segment by segment (so `/caf%C3%A9` and `/café` are one
 * address, as Next hands both to the page), without a trailing slash. Refused: a query or fragment, an empty, `.` or
 * `..` segment, a segment holding an encoded `/` (it would be a second spelling of another path), a broken escape,
 * control characters, and anything longer or deeper than a public route can be.
 */
export function parseSitePath(input: string, role: "source" | "destination"): Parsed<string> {
  const raw = input.trim();
  if (!raw) return refuse(role === "source" ? "Enter the old address, like /old-page." : "Enter where it goes, like /new-page.");
  if (!raw.startsWith("/") || raw.startsWith("//")) return refuse("Start with / and the path on this site, like /old-page.");
  if (/[?#]/.test(raw)) return refuse("Use the path alone, without ?… or #….");
  if (FORBIDDEN.test(raw)) return refuse("Use the address as it is typed in a browser, without quotes, tabs or line breaks.");
  const trimmed = raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (trimmed === "/") {
    return role === "source" ? refuse("The home page cannot be redirected.") : { ok: true, value: "/" };
  }
  const segments: string[] = [];
  for (const segment of trimmed.slice(1).split("/")) {
    if (!segment) return refuse("Use single slashes between the parts of the path.");
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return refuse("This address has a broken %-escape.");
    }
    if (decoded.includes("/")) return refuse("Use / between the parts of the path, not %2F.");
    if (decoded === "." || decoded === "..") return refuse("Use the path itself, without . or .. parts.");
    if (FORBIDDEN.test(decoded)) return refuse("Use the address as it is typed in a browser, without quotes, tabs or line breaks.");
    segments.push(decoded);
  }
  if (segments.length > REDIRECT_SEGMENTS_MAX) return refuse(`Use at most ${REDIRECT_SEGMENTS_MAX} parts in the path.`);
  const path = `/${segments.join("/")}`;
  if (path.length > REDIRECT_PATH_MAX) return refuse(`Use at most ${REDIRECT_PATH_MAX} characters.`);
  if (role === "source" && RESERVED_REDIRECT_PATHS.some((root) => within(path, root))) return refuse("That address is used by Forge on every site.");
  return { ok: true, value: path };
}

export type RedirectDestination = { kind: "path"; value: string } | { kind: "url"; value: string };

/**
 * Where a redirect may send visitors: a path of this site, or an absolute http(s) address on another host (never
 * this deployment's own host: that would reach another site or the admin; use a path instead). Nothing else: no
 * `javascript:` or `data:`, no `//host`, no credentials.
 */
export function parseRedirectDestination(input: string, appHost: string | null): Parsed<RedirectDestination> {
  const raw = input.trim();
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    const path = parseSitePath(raw, "destination");
    return path.ok ? { ok: true, value: { kind: "path", value: path.value } } : path;
  }
  if (!/^https?:\/\//i.test(raw)) return refuse("Use a path on this site (starting with /) or a full address starting with https://.");
  if (raw.length > REDIRECT_URL_MAX) return refuse(`Use at most ${REDIRECT_URL_MAX} characters.`);
  if (/[\s\u0000-\u001f\u007f<>"`\\]/.test(raw)) return refuse("Use the address as it is typed in a browser, without spaces or quotes.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("That is not a full address. Use one like https://example.com/page.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return refuse("Use a full address starting with https://.");
  if (url.username || url.password) return refuse("Use an address without a user name or password in it.");
  if (appHost && url.host.toLowerCase() === appHost.toLowerCase()) return refuse("That address is on Forge itself. Use a path on this site, like /about.");
  if (url.href.length > REDIRECT_URL_MAX) return refuse(`Use at most ${REDIRECT_URL_MAX} characters.`);
  return { ok: true, value: { kind: "url", value: url.href } };
}

export const isSitePath = (destination: string): boolean => destination.startsWith("/");

/** A site path as a URL path: each segment percent-encoded again (`/café` → `/caf%C3%A9`). */
export const encodeSitePath = (path: string): string => (path === "/" ? "/" : `/${path.slice(1).split("/").map(encodeURIComponent).join("/")}`);

/** Where a chain of the site's active redirects ends (`map`: source → destination), followed from `start`. */
export type ChainEnd = { kind: "end"; destination: string; hops: number } | { kind: "loop" } | { kind: "too-long" };

export function followRedirects(map: ReadonlyMap<string, string>, start: string, avoid: string | null = null, max = REDIRECT_DEPTH_MAX): ChainEnd {
  let current = start;
  const seen = new Set<string>([current]);
  for (let hops = 0; ; hops++) {
    if (!isSitePath(current)) return { kind: "end", destination: current, hops };
    const next = map.get(current);
    if (next === undefined) return { kind: "end", destination: current, hops };
    if (hops + 1 > max) return { kind: "too-long" };
    if (next === avoid || seen.has(next)) return { kind: "loop" };
    seen.add(next);
    current = next;
  }
}

export type WritePlan =
  | { ok: true; destination: string; flattened: boolean; rewrites: { source: string; destination: string }[] }
  | { ok: false; reason: "self" | "loop" | "too-long" };

/**
 * How `source → destination` is written into the site's active redirects (`active`: source → destination, the row
 * being written left out): its destination followed to the end of its chain (A→B with B→C stores A→C), and every
 * redirect that ends at `source` pointed at that end instead (A→B written while X→A exists makes X→B). Refused: a
 * redirect to itself, one whose chain comes back to it, one whose chain is longer than ten steps.
 */
export function planRedirectWrite(active: ReadonlyMap<string, string>, source: string, destination: string): WritePlan {
  if (destination === source) return { ok: false, reason: "self" };
  const end = followRedirects(active, destination, source);
  if (end.kind !== "end") return { ok: false, reason: end.kind };
  if (end.destination === source) return { ok: false, reason: "loop" };
  const rewrites: { source: string; destination: string }[] = [];
  for (const [from, to] of active) {
    if (to !== source || from === source) continue;
    // `from` → source → … → end: `from` is the end itself only if the chain came back to it (a loop, refused above).
    if (from === end.destination) return { ok: false, reason: "loop" };
    rewrites.push({ source: from, destination: end.destination });
  }
  return { ok: true, destination: end.destination, flattened: end.destination !== destination, rewrites };
}

export const REDIRECT_REFUSALS: Readonly<Record<"self" | "loop" | "too-long", string>> = {
  self: "A redirect cannot send visitors to its own address.",
  loop: "This would send visitors in a loop: the address it goes to leads back here.",
  "too-long": `The address it goes to is redirected more than ${REDIRECT_DEPTH_MAX} times. Point it at the end of that chain.`,
};

/**
 * Which of the blog's routes a path is (rendering/routes.ts gives the same answer for the same spelling): its index,
 * a later page of a list, or a category's or tag's archive. Null for any other path.
 */
export type BlogRoute = { kind: "index" } | { kind: "list-page" } | { kind: "archive"; taxonomy: "category" | "tag"; slug: string };

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PAGE = /^[1-9][0-9]{0,4}$/;

export function blogRouteOf(path: string, blogPath: string): BlogRoute | null {
  const segments = path.split("/").slice(1);
  if (segments[0] !== blogPath || !segments.every((segment) => SLUG.test(segment))) return null;
  const [, first, second, third, fourth] = segments;
  if (segments.length === 1) return { kind: "index" };
  if (segments.length === 3 && first === "page" && PAGE.test(second!) && Number(second) >= 2) return { kind: "list-page" };
  if (first === "category" || first === "tag") {
    if (segments.length === 3) return { kind: "archive", taxonomy: first, slug: second! };
    if (segments.length === 5 && third === "page" && PAGE.test(fourth!) && Number(fourth) >= 2) return { kind: "list-page" };
  }
  return null;
}

/** A term's archive address on the site (rendering's `/{blogPath}/{category|tag}/{slug}`). */
export const archivePath = (blogPath: string, taxonomy: "category" | "tag", slug: string): string => `/${blogPath}/${taxonomy}/${slug}`;
