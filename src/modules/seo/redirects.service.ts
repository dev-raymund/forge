import "server-only";
import { record } from "@/modules/audit";
import { inTenant, requirePermission, type SiteContext } from "@/modules/tenancy";
import type { CacheEvent } from "@/platform/cache";
import { env } from "@/platform/config/env";
import type { TenantTx } from "@/platform/db";
import { notFound, validationError } from "@/platform/errors";
import {
  activeMap, countRedirects, deactivateSources, deleteRedirectRow, entryChoice, findBySource, findRedirect, insertRedirect, lockRedirects, redirectDestinations,
  redirectsPage, servedPaths, setNotFoundEntry, siteAddress, siteRouting, termSlugsOfSite, updateRedirectRow, upsertRedirect,
  type RedirectRow, type Served, type SiteRouting,
} from "./redirect.repository";
import {
  archivePath, AUTO_REDIRECT_STATUS, DEFAULT_REDIRECT_STATUS, isSitePath, parseRedirectDestination, parseSitePath, planRedirectWrite, REDIRECT_REFUSALS, REDIRECTS_MAX,
  type RedirectStatus,
} from "./redirects";
import { createRedirectSchema, isUuid, parseInput, updateRedirectSchema } from "./validation";

/**
 * A site's redirects (M8-5; plan §9–10, §19 `/…/seo/redirects`; ADR 0032). Two kinds of writer, one set of rules:
 *
 *   by hand     `site.seo.manage` (Owner, Admin, Editor): add, change (destination, status, on/off), delete, each
 *               recorded; and "redirect this address to…" when unpublishing (plan §9)
 *   by Forge    a live address that changes (a publish with a new slug or parent, a page moved, the Home page changed,
 *               a new blog path, a category or tag renamed) leaves a 301 from the old address to the new one, in the
 *               transaction that changes it; content taking an address turns off the redirect from it
 *
 * The rules, wherever a redirect is written:
 *   - a source is an address nothing on the site serves now (no published page or post there, not the home page, the
 *     blog, an archive or a list page): content always wins its own address;
 *   - a destination is a path the site serves now, or an http(s) address elsewhere;
 *   - chains are flattened and loops refused (./redirects.ts), under a per-site lock, so the map holds one hop each.
 * Each write returns `site.configChanged`: the public site reads the map under `site:{id}:config`.
 */

type Scope = { readonly org: { readonly id: string }; readonly site: { readonly id: string } };

export type RedirectNotice = { source: string; destination: string };
/** What a content change did to the site's redirects: made (old → new), turned off (content took the address), chains shortened. */
export type RedirectChanges = { made: RedirectNotice[]; turnedOff: RedirectNotice[]; repointed: number };
export const NO_REDIRECT_CHANGES: RedirectChanges = { made: [], turnedOff: [], repointed: 0 };

const changedAny = (changes: RedirectChanges) => changes.made.length > 0 || changes.turnedOff.length > 0 || changes.repointed > 0;

/** The cache event a change to the redirects needs: the public site's map is read under `site:{id}:config`. */
export const redirectEvents = (siteId: string, changes: RedirectChanges): CacheEvent[] => (changedAny(changes) ? [{ type: "site.configChanged", siteId }] : []);

/** What the editor says about redirects content just turned off ("publishing at a redirected path … with a notice"). */
export function turnedOffNotice(changes: RedirectChanges): string | null {
  const off = changes.turnedOff;
  if (!off.length) return null;
  if (off.length === 1) return `The redirect from ${off[0]!.source} is turned off: the site shows its own content there now.`;
  const listed = off.slice(0, 3).map((one) => one.source).join(", ");
  return `${off.length} redirects are turned off (${listed}${off.length > 3 ? ", …" : ""}): the site shows its own content at those addresses now.`;
}

const appHost = (): string | null => {
  try {
    return new URL(env("core").APP_ORIGIN).host;
  } catch {
    return null;
  }
};

// ── Written by Forge, inside the transaction that changes an address ─────────

/**
 * In the transaction of a content change, after the content's own rows are written: every address now served by what
 * changed (`claimed`) loses its redirect, and each live address that moved and that nothing serves now redirects to
 * where its content went (301), with the redirects that ended at the old address pointed straight at the new one.
 * A failure here fails the whole change: nothing has moved, and no redirect claims it did.
 */
export async function redirectPathChanges(
  tx: TenantTx, scope: Scope, change: { moves: readonly { from: string; to: string }[]; claimed: readonly string[] }, by: string | null,
): Promise<RedirectChanges> {
  const moves = change.moves.filter((move) => move.from !== move.to);
  const claimed = [...new Set([...change.claimed, ...moves.map((move) => move.to)])];
  if (!moves.length && !claimed.length) return NO_REDIRECT_CHANGES;
  const [org, site] = [scope.org.id, scope.site.id];
  await lockRedirects(tx, site);
  const routing = await siteRouting(tx, org, site);
  if (!routing) return NO_REDIRECT_CHANGES;

  // 1. Content lives at these addresses now: no redirect may shadow it.
  const turnedOff = await deactivateSources(tx, org, site, claimed);
  // 2. An old address that something else serves now (the Home page's `/`, taken by the new Home) keeps that content.
  const served = await servedPaths(tx, org, site, routing, moves.map((move) => move.from));
  const made: RedirectNotice[] = [];
  let repointed = 0;
  for (const move of moves) {
    if (served.has(move.from) || made.some((one) => one.source === move.from)) continue;
    await upsertRedirect(tx, org, site, { sourcePath: move.from, destination: move.to, statusCode: AUTO_REDIRECT_STATUS, origin: "auto", isActive: true, createdBy: by });
    repointed += await redirectDestinations(tx, org, site, move.from, move.to);
    made.push({ source: move.from, destination: move.to });
  }
  return { made, turnedOff, repointed };
}

/**
 * The blog moved (reading settings): its index and every category's and tag's archive redirect to their new
 * addresses. Posts stay at the paths they were published at (ADR 0017) until they are published again, which moves
 * each one with its own redirect; later pages of the old lists are not redirected (exact match only).
 */
export async function redirectBlogPath(tx: TenantTx, scope: Scope, from: string, to: string, by: string | null): Promise<RedirectChanges> {
  if (from === to) return NO_REDIRECT_CHANGES;
  const terms = await termSlugsOfSite(tx, scope.org.id, scope.site.id);
  const moves = [{ from: `/${from}`, to: `/${to}` }, ...terms.map((term) => ({ from: archivePath(from, term.taxonomy, term.slug), to: archivePath(to, term.taxonomy, term.slug) }))];
  return redirectPathChanges(tx, scope, { moves, claimed: moves.map((move) => move.to) }, by);
}

// ── The rules for a redirect written by hand ─────────────────────────────────

const SERVED_SOURCE: Readonly<Record<Served, (path: string) => string>> = {
  home: () => "The home page cannot be redirected.",
  entry: (path) => `A published page or post is at ${path}. Unpublish it or change its address first.`,
  blog: (path) => `${path} is the blog's address.`,
  archive: (path) => `${path} is a category's or tag's archive. Rename or delete the category or tag first.`,
  "list-page": (path) => `${path} is one of the blog's list pages.`,
};

/** A source as typed: parsed, and free (nothing the site serves). */
async function freeSource(tx: TenantTx, scope: Scope, routing: SiteRouting, input: string, field: string): Promise<string> {
  const parsed = parseSitePath(input, "source");
  if (!parsed.ok) throw validationError({ [field]: [parsed.message] });
  const served = (await servedPaths(tx, scope.org.id, scope.site.id, routing, [parsed.value])).get(parsed.value);
  if (served) throw validationError({ [field]: [SERVED_SOURCE[served](parsed.value)] });
  return parsed.value;
}

/**
 * A destination as typed, for a redirect from `source`: parsed; a path must be one the site serves now (or another
 * redirect's source, which is followed to its end); no loop, no chain past ten; flattened. Returns what to store.
 */
async function plannedDestination(tx: TenantTx, scope: Scope, routing: SiteRouting, source: string, input: string, field: string) {
  const parsed = parseRedirectDestination(input, appHost());
  if (!parsed.ok) throw validationError({ [field]: [parsed.message] });
  const active = await activeMap(tx, scope.org.id, scope.site.id);
  active.delete(source);
  const plan = planRedirectWrite(active, source, parsed.value.value);
  if (!plan.ok) throw validationError({ [field]: [REDIRECT_REFUSALS[plan.reason]] });
  if (isSitePath(plan.destination)) {
    const served = (await servedPaths(tx, scope.org.id, scope.site.id, routing, [plan.destination])).get(plan.destination);
    if (served === "list-page") throw validationError({ [field]: ["Send visitors to the list itself (its first page), like the blog's address."] });
    if (!served) {
      throw validationError({
        [field]: [
          plan.flattened
            ? `${parsed.value.value} redirects to ${plan.destination}, where nothing is published on this site.`
            : `Nothing is published at ${plan.destination} on this site. Publish it first, or choose another address.`,
        ],
      });
    }
  }
  return { typed: parsed.value.value, destination: plan.destination, flattened: plan.flattened };
}

// ── The redirects page ───────────────────────────────────────────────────────

export type RedirectView = {
  id: string;
  source: string;
  destination: string;
  external: boolean;
  statusCode: RedirectStatus;
  origin: "manual" | "auto";
  isActive: boolean;
  updatedAt: string;
  /** For a path: whether the site serves it now (if not, visitors of the source get "not found"). Null for an address elsewhere. */
  destinationLive: boolean | null;
};

export type RedirectsView = {
  redirects: RedirectView[];
  total: number;
  page: number;
  pages: number;
  query: string;
  /** The site's not-found page (null: the theme's), and whether the site shows it now. */
  notFoundPage: { id: string; title: string; path: string; live: boolean } | null;
  siteName: string;
  /** The site's public base (`/s/{address}`), or null while it has no address. */
  siteBase: string | null;
};

export const REDIRECTS_PAGE_SIZE = 50;

const viewOf = (row: RedirectRow, live: boolean | null): RedirectView => ({
  id: row.id, source: row.sourcePath, destination: row.destination, external: !isSitePath(row.destination), statusCode: row.statusCode, origin: row.origin,
  isActive: row.isActive, updatedAt: row.updatedAt.toISOString(), destinationLive: live,
});

/** The redirects page's data: a page of the site's redirects (newest first, matching `query`), and its not-found page. */
export async function getRedirects(ctx: SiteContext, options: { query?: string; page?: number } = {}): Promise<RedirectsView> {
  requirePermission(ctx, "site.seo.manage");
  const query = (options.query ?? "").trim().slice(0, 200);
  const page = Number.isInteger(options.page) && options.page! > 0 ? options.page! : 1;
  return inTenant(ctx, async (tx) => {
    const routing = await siteRouting(tx, ctx.org.id, ctx.site.id);
    if (!routing) throw notFound();
    const { rows, total } = await redirectsPage(tx, ctx.org.id, ctx.site.id, { query, offset: (page - 1) * REDIRECTS_PAGE_SIZE, limit: REDIRECTS_PAGE_SIZE });
    const served = await servedPaths(tx, ctx.org.id, ctx.site.id, routing, rows.map((row) => row.destination).filter(isSitePath));
    const live = (row: RedirectRow) => (isSitePath(row.destination) ? (served.has(row.destination) && served.get(row.destination) !== "list-page") : null);
    const choice = routing.notFoundEntryId ? await entryChoice(tx, ctx.org.id, ctx.site.id, routing.notFoundEntryId) : null;
    const address = await siteAddress(tx, ctx.org.id, ctx.site.id);
    return {
      redirects: rows.map((row) => viewOf(row, live(row))),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / REDIRECTS_PAGE_SIZE)),
      query,
      notFoundPage: choice ? { id: choice.id, title: choice.title, path: choice.path, live: choice.status === "published" && !choice.deleted } : null,
      siteName: routing.name,
      siteBase: address ? `/s/${address}` : null,
    };
  });
}

export type RedirectSaved = { redirect: RedirectView; changed: boolean; notes: string[]; events: CacheEvent[] };

const repointedNote = (n: number, to: string) => (n ? `${n === 1 ? "1 redirect that went" : `${n} redirects that went`} there now ${n === 1 ? "goes" : "go"} straight to ${to}.` : null);

/** A redirect made by hand. Its source must be free and not already redirected; its destination served (or redirected on). */
export async function createRedirect(ctx: SiteContext, input: unknown): Promise<RedirectSaved> {
  requirePermission(ctx, "site.seo.manage");
  const values = parseInput(createRedirectSchema, input);
  return inTenant(ctx, async (tx) => {
    await lockRedirects(tx, ctx.site.id);
    const routing = await siteRouting(tx, ctx.org.id, ctx.site.id);
    if (!routing) throw notFound();
    const source = await freeSource(tx, ctx, routing, values.source, "source");
    if (await findBySource(tx, ctx.org.id, ctx.site.id, source)) throw validationError({ source: [`There is already a redirect from ${source}. Change that one instead.`] });
    if ((await countRedirects(tx, ctx.org.id, ctx.site.id)) >= REDIRECTS_MAX) {
      throw validationError({ source: [`A site holds at most ${REDIRECTS_MAX.toLocaleString("en")} redirects. Delete some you no longer need first.`] });
    }
    const plan = await plannedDestination(tx, ctx, routing, source, values.destination, "destination");
    const row = await insertRedirect(tx, ctx.org.id, ctx.site.id, {
      sourcePath: source, destination: plan.destination, statusCode: values.statusCode, origin: "manual", isActive: true, createdBy: ctx.actor.userId,
    });
    const repointed = await redirectDestinations(tx, ctx.org.id, ctx.site.id, source, plan.destination);
    await record(
      tx,
      { action: "redirect.created", resourceType: "redirect", resourceId: row.id, siteId: ctx.site.id, metadata: { name: routing.name, source, destination: plan.destination, statusCode: values.statusCode } },
      ctx,
    );
    const notes = [
      plan.flattened ? `It goes straight to ${plan.destination}: ${plan.typed} redirects there.` : null,
      repointedNote(repointed, plan.destination),
    ].filter((note): note is string => note !== null);
    return { redirect: viewOf(row, isSitePath(row.destination) ? true : null), changed: true, notes, events: [{ type: "site.configChanged", siteId: ctx.site.id }] };
  });
}

/** Changes a redirect's destination, status code or whether it is on. Turning one on checks its source and destination again. */
export async function updateRedirect(ctx: SiteContext, redirectId: unknown, input: unknown): Promise<RedirectSaved> {
  requirePermission(ctx, "site.seo.manage");
  if (!isUuid(redirectId)) throw notFound();
  const values = parseInput(updateRedirectSchema, input);
  return inTenant(ctx, async (tx) => {
    await lockRedirects(tx, ctx.site.id);
    const routing = await siteRouting(tx, ctx.org.id, ctx.site.id);
    const row = routing ? await findRedirect(tx, ctx.org.id, ctx.site.id, redirectId, { lock: true }) : null;
    if (!routing || !row) throw notFound();
    const isActive = values.isActive ?? row.isActive;
    const statusCode = values.statusCode ?? row.statusCode;
    let destination = row.destination;
    const notes: string[] = [];
    if (isActive && !row.isActive) await freeSource(tx, ctx, routing, row.sourcePath, "isActive");
    if (isActive && (values.destination !== undefined || !row.isActive)) {
      const plan = await plannedDestination(tx, ctx, routing, row.sourcePath, values.destination ?? row.destination, "destination");
      destination = plan.destination;
      if (plan.flattened) notes.push(`It goes straight to ${plan.destination}: ${plan.typed} redirects there.`);
    } else if (values.destination !== undefined) {
      // Off: only its shape is checked now; turning it on checks the rest.
      const parsed = parseRedirectDestination(values.destination, appHost());
      if (!parsed.ok) throw validationError({ destination: [parsed.message] });
      if (parsed.value.value === row.sourcePath) throw validationError({ destination: [REDIRECT_REFUSALS.self] });
      destination = parsed.value.value;
    }
    const fields = [
      ...(destination !== row.destination ? (["destination"] as const) : []),
      ...(statusCode !== row.statusCode ? (["status"] as const) : []),
      ...(isActive !== row.isActive ? (["active"] as const) : []),
    ];
    if (!fields.length) return { redirect: viewOf(row, null), changed: false, notes: [], events: [] };
    const saved = (await updateRedirectRow(tx, ctx.org.id, ctx.site.id, row.id, { destination, statusCode, isActive }))!;
    if (isActive) {
      const note = repointedNote(await redirectDestinations(tx, ctx.org.id, ctx.site.id, row.sourcePath, destination), destination);
      if (note) notes.push(note);
    }
    await record(
      tx,
      {
        action: "redirect.updated", resourceType: "redirect", resourceId: row.id, siteId: ctx.site.id,
        metadata: { name: routing.name, source: row.sourcePath, destination, statusCode, active: isActive, fields: [...fields] },
      },
      ctx,
    );
    return { redirect: viewOf(saved, null), changed: true, notes, events: [{ type: "site.configChanged", siteId: ctx.site.id }] };
  });
}

/** Deletes a redirect: its source answers "not found" again (or what the site publishes there later). */
export async function deleteRedirect(ctx: SiteContext, redirectId: unknown): Promise<{ source: string; events: CacheEvent[] }> {
  requirePermission(ctx, "site.seo.manage");
  if (!isUuid(redirectId)) throw notFound();
  return inTenant(ctx, async (tx) => {
    await lockRedirects(tx, ctx.site.id);
    const routing = await siteRouting(tx, ctx.org.id, ctx.site.id);
    const row = routing ? await findRedirect(tx, ctx.org.id, ctx.site.id, redirectId, { lock: true }) : null;
    if (!routing || !row) throw notFound();
    await deleteRedirectRow(tx, ctx.org.id, ctx.site.id, row.id);
    await record(
      tx,
      { action: "redirect.deleted", resourceType: "redirect", resourceId: row.id, siteId: ctx.site.id, metadata: { name: routing.name, source: row.sourcePath, destination: row.destination } },
      ctx,
    );
    return { source: row.sourcePath, events: [{ type: "site.configChanged", siteId: ctx.site.id }] };
  });
}

/**
 * Unpublish's "redirect this address to…" (plan §9), in the unpublish's transaction, once the entry is a draft: a
 * redirect by hand (301) from the address it was at, replacing any left there. `site.seo.manage` only. A destination
 * that fails the rules fails the unpublish too, keyed `redirectTo`.
 */
export async function redirectUnpublished(tx: TenantTx, ctx: SiteContext, source: string, input: string): Promise<RedirectChanges> {
  requirePermission(ctx, "site.seo.manage");
  await lockRedirects(tx, ctx.site.id);
  const routing = await siteRouting(tx, ctx.org.id, ctx.site.id);
  if (!routing) throw notFound();
  const from = await freeSource(tx, ctx, routing, source, "redirectTo");
  const plan = await plannedDestination(tx, ctx, routing, from, input, "redirectTo");
  const row = await upsertRedirect(tx, ctx.org.id, ctx.site.id, {
    sourcePath: from, destination: plan.destination, statusCode: DEFAULT_REDIRECT_STATUS, origin: "manual", isActive: true, createdBy: ctx.actor.userId,
  });
  const repointed = await redirectDestinations(tx, ctx.org.id, ctx.site.id, from, plan.destination);
  await record(
    tx,
    { action: "redirect.created", resourceType: "redirect", resourceId: row.id, siteId: ctx.site.id, metadata: { name: routing.name, source: from, destination: plan.destination, statusCode: row.statusCode } },
    ctx,
  );
  return { made: [{ source: from, destination: plan.destination }], turnedOff: [], repointed };
}

// ── The not-found page (plan §10 "custom 404 page setting") ──────────────────

/**
 * Names the page the site shows, with a real 404 status, at an address it does not have (null: the theme's own
 * not-found page). A published page of the site, not the Home page. If it is unpublished or deleted later, the theme's
 * page is shown again (the public site checks it on every read; a page deleted for good clears it, `ON DELETE SET NULL`).
 */
export async function setNotFoundPage(ctx: SiteContext, entryId: unknown): Promise<{ changed: boolean; events: CacheEvent[] }> {
  requirePermission(ctx, "site.seo.manage");
  const id = entryId === null || entryId === "" ? null : entryId;
  if (id !== null && !isUuid(id)) throw validationError({ entryId: ["Choose a page of this site."] });
  return inTenant(ctx, async (tx) => {
    const routing = await siteRouting(tx, ctx.org.id, ctx.site.id);
    if (!routing) throw notFound();
    if (id) {
      const choice = await entryChoice(tx, ctx.org.id, ctx.site.id, id);
      // Not one of this site's entries (another site's id, or none): nothing of it is said.
      if (!choice) throw notFound();
      if (choice.deleted) throw validationError({ entryId: ["Choose a page of this site that is not in the trash."] });
      if (choice.type !== "page") throw validationError({ entryId: ["Choose a page: a post cannot be the not-found page."] });
      if (choice.path === "/") throw validationError({ entryId: ["The home page cannot be the not-found page."] });
      if (choice.status !== "published") throw validationError({ entryId: ["Publish the page first: the site shows only published pages."] });
    }
    if (routing.notFoundEntryId === id) return { changed: false, events: [] };
    await setNotFoundEntry(tx, ctx.org.id, ctx.site.id, id, ctx.actor.userId);
    await record(
      tx,
      { action: "site.settings_changed", resourceType: "site", resourceId: ctx.site.id, siteId: ctx.site.id, metadata: { name: routing.name, group: "seo", fields: ["notFoundPage"] } },
      ctx,
    );
    return { changed: true, events: [{ type: "site.configChanged", siteId: ctx.site.id }] };
  });
}
