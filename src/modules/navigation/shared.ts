import { z } from "zod";
import { safeHref } from "@/themes/_kit/tokens";

/**
 * A site's menus (M8-3; plan §4.1, §7; ADR 0030): client-safe. One menu per location, its items a tree of two levels at
 * most, saved as a whole. Each item is a link to one destination:
 *
 *   entry     a page or a post, by id: drawn at its live path, while it is published (the label defaults to its title)
 *   term      a category's or a tag's archive, by id (the label defaults to its name)
 *   archive   the posts' archive, the blog (the label defaults to "Blog")
 *   url       a path on the site (`/contact`) or a web, mail or phone address (`safeHref`, the header button's rule)
 *
 * Ids, not addresses: a renamed page keeps its link, and an item whose destination is not public is left out of the
 * site (and flagged in the editor) without the menu being rewritten.
 */

export const MENU_LOCATIONS = ["header", "footer"] as const;
export type MenuLocation = (typeof MENU_LOCATIONS)[number];
export const isMenuLocation = (value: unknown): value is MenuLocation => typeof value === "string" && (MENU_LOCATIONS as readonly string[]).includes(value);

/** Every item, at both levels, counts. */
export const MENU_ITEMS_MAX = 100;
export const MENU_LABEL_MAX = 80;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNREADABLE = "This menu could not be read. Reload the page and try again.";
const uuid = z.string().regex(UUID, UNREADABLE);
const label = z.string().trim().max(MENU_LABEL_MAX, `Use at most ${MENU_LABEL_MAX} characters.`);
const common = { id: uuid, label, newTab: z.boolean() };

/** One link, of any kind, with nothing under it. */
const link = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ ...common, kind: z.literal("entry"), entryId: uuid }),
    z.strictObject({ ...common, kind: z.literal("term"), termId: uuid }),
    z.strictObject({ ...common, kind: z.literal("archive"), contentType: z.literal("post", "Only the blog has an archive.") }),
    z.strictObject({ ...common, kind: z.literal("url"), url: safeHref, label: label.min(1, "Give the link a label.") }),
  ],
  "Choose a page, a post, a category, the blog or an address.",
);
export type MenuLink = z.output<typeof link>;
export type MenuItem = MenuLink & { children?: MenuLink[] };
export type MenuItemKind = MenuLink["kind"];

/** An item's own fields: what it says about its destination, not the links under it. */
const withoutChildren = (value: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "children"));

export const countItems = (items: readonly MenuItem[]): number => items.reduce((n, one) => n + 1 + (one.children?.length ?? 0), 0);
export const flatten = (items: readonly MenuItem[]): MenuLink[] => items.flatMap(({ children, ...one }) => [one, ...(children ?? [])]);

/** Where an error about the item with this id is shown in the editor (`item.{id}`); `items` for the menu as a whole. */
export const itemErrorKey = (id: string) => `item.${id}`;

export type MenuCheck = { ok: true; items: MenuItem[] } | { ok: false; errors: Record<string, string[]> };

/**
 * A menu as it is saved, checked strictly: an array of items, each a link of one of the four kinds with nothing it does
 * not name (no `javascript:`: `safeHref`), at most two levels, at most `MENU_ITEMS_MAX` items in all, each id once.
 * Errors are keyed by the item they are about (`itemErrorKey`), or `items`.
 */
export function checkMenuItems(input: unknown): MenuCheck {
  const errors: Record<string, string[]> = {};
  const add = (key: string, message: string) => void (errors[key] ??= []).push(message);
  if (!Array.isArray(input)) return { ok: false, errors: { items: [UNREADABLE] } };
  const keyOf = (value: unknown) => {
    const id = value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
    return typeof id === "string" && UUID.test(id) ? itemErrorKey(id) : "items";
  };
  const one = (value: unknown): MenuLink | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      add("items", UNREADABLE);
      return null;
    }
    const rest = withoutChildren(value as Record<string, unknown>);
    const parsed = link.safeParse(rest);
    if (parsed.success) return parsed.data;
    add(keyOf(value), parsed.error.issues[0]!.message);
    return null;
  };
  const items: MenuItem[] = [];
  for (const value of input) {
    const parent = one(value);
    const raw = value && typeof value === "object" ? (value as { children?: unknown }).children : undefined;
    if (raw !== undefined && !Array.isArray(raw)) add(keyOf(value), UNREADABLE);
    const children: MenuLink[] = [];
    for (const child of Array.isArray(raw) ? raw : []) {
      const under = one(child);
      const deeper = child && typeof child === "object" ? (child as { children?: unknown }).children : undefined;
      if (Array.isArray(deeper) && deeper.length > 0) add(keyOf(child), "A link under another cannot have links under it: menus have two levels.");
      if (under) children.push(under);
    }
    if (parent) items.push(children.length ? { ...parent, children } : parent);
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  if (countItems(items) > MENU_ITEMS_MAX) return { ok: false, errors: { items: [`A menu holds at most ${MENU_ITEMS_MAX} links.`] } };
  const ids = flatten(items).map((x) => x.id);
  if (new Set(ids).size !== ids.length) return { ok: false, errors: { items: [UNREADABLE] } };
  return { ok: true, items };
}

/**
 * A stored menu, read value by value (the public site, the editor): an item that does not read as one is left out,
 * and so is what goes past two levels or `MENU_ITEMS_MAX` items. A damaged menu draws fewer links, never an error.
 */
export function readMenuItems(stored: unknown): MenuItem[] {
  if (!Array.isArray(stored)) return [];
  const out: MenuItem[] = [];
  const seen = new Set<string>();
  let count = 0;
  const one = (value: unknown): MenuLink | null => {
    if (!value || typeof value !== "object" || count >= MENU_ITEMS_MAX) return null;
    const rest = withoutChildren(value as Record<string, unknown>);
    const parsed = link.safeParse({ ...rest, newTab: rest.newTab === true });
    if (!parsed.success || seen.has(parsed.data.id)) return null;
    seen.add(parsed.data.id);
    count++;
    return parsed.data;
  };
  for (const value of stored) {
    const parent = one(value);
    if (!parent) continue;
    const raw = (value as { children?: unknown }).children;
    const children = (Array.isArray(raw) ? raw : []).map(one).filter((x): x is MenuLink => x !== null);
    out.push(children.length ? { ...parent, children } : parent);
  }
  return out;
}

/** What an item points at, as a key: the editor's and the resolver's lookups (`entry:{id}`, `term:{id}`, `archive:post`). */
export function targetKey(one: MenuLink): string | null {
  switch (one.kind) {
    case "entry":
      return `entry:${one.entryId}`;
    case "term":
      return `term:${one.termId}`;
    case "archive":
      return `archive:${one.contentType}`;
    case "url":
      return null;
  }
}

/**
 * What the editor knows of an item's destination: its name and where it is, and whether the site shows it. Only `live`
 * destinations are drawn; the others are kept in the menu and flagged, so publishing or restoring brings them back.
 */
export type MenuTargetState = "live" | "unpublished" | "scheduled" | "trashed" | "deleted";
export type MenuTarget = { title: string; detail: string; state: MenuTargetState };

/** A menu as the editor opens it: its items, its version (0: never saved), and what its items point at, by `targetKey`. */
export type EditorMenu = { location: MenuLocation; version: number; items: MenuItem[]; targets: Record<string, MenuTarget> };

/** The blog's default label, as its index titles itself. */
export const BLOG_LABEL = "Blog";
