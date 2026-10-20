import type { MenuItem, MenuLink } from "./shared";

/**
 * Arranging a menu in the editor (M8-3): pure, so the keyboard's moves, a drag and the tests agree. Every change keeps
 * the menu at two levels: a link with links under it stays at the top; a link goes under a top-level link only.
 * A move that cannot be made returns the menu unchanged.
 */

type Found = { parentId: string | null; index: number; siblings: readonly MenuItem[] };

/** Where the item is: under which link (null: the top), at which place among its siblings. */
export function positionOf(items: readonly MenuItem[], id: string): Found | null {
  const top = items.findIndex((one) => one.id === id);
  if (top >= 0) return { parentId: null, index: top, siblings: items };
  for (const parent of items) {
    const index = (parent.children ?? []).findIndex((one) => one.id === id);
    if (index >= 0) return { parentId: parent.id, index, siblings: parent.children! };
  }
  return null;
}

export function findItem(items: readonly MenuItem[], id: string): MenuItem | null {
  for (const one of items) {
    if (one.id === id) return one;
    const child = one.children?.find((under) => under.id === id);
    if (child) return child;
  }
  return null;
}

const withChildren = (item: MenuLink | MenuItem, children: MenuLink[]): MenuItem => {
  const own: MenuItem = { ...item };
  delete own.children;
  return children.length ? { ...own, children } : own;
};

/** The menu without the item (and, at the top, without the links under it). */
export function removeItem(items: readonly MenuItem[], id: string): MenuItem[] {
  return items.filter((one) => one.id !== id).map((one) => (one.children?.some((under) => under.id === id) ? withChildren(one, one.children.filter((under) => under.id !== id)) : one));
}

export function updateItem(items: readonly MenuItem[], id: string, change: Partial<Pick<MenuLink, "label" | "newTab">>): MenuItem[] {
  return items.map((one) =>
    one.id === id
      ? { ...one, ...change }
      : one.children?.some((under) => under.id === id)
        ? withChildren(one, one.children.map((under) => (under.id === id ? { ...under, ...change } : under)))
        : one,
  );
}

const swap = <T>(list: readonly T[], a: number, b: number): T[] => {
  const next = [...list];
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
};

/** One place up or down among its siblings. */
export function moveItem(items: readonly MenuItem[], id: string, direction: -1 | 1): MenuItem[] {
  const at = positionOf(items, id);
  if (!at) return [...items];
  const to = at.index + direction;
  if (to < 0 || to >= at.siblings.length) return [...items];
  if (at.parentId === null) return swap(items, at.index, to);
  return items.map((one) => (one.id === at.parentId ? withChildren(one, swap(one.children!, at.index, to)) : one));
}

/** Can it go under the top-level link above it? Only a top-level link with nothing under it. */
export function canIndent(items: readonly MenuItem[], id: string): boolean {
  const at = positionOf(items, id);
  return !!at && at.parentId === null && at.index > 0 && !(items[at.index]!.children?.length);
}

/** Under the top-level link above it, as its last link. */
export function indentItem(items: readonly MenuItem[], id: string): MenuItem[] {
  if (!canIndent(items, id)) return [...items];
  const at = positionOf(items, id)!;
  const item = withChildren(items[at.index]!, []) as MenuLink;
  const above = items[at.index - 1]!;
  return items.flatMap((one, index) => (index === at.index ? [] : index === at.index - 1 ? [withChildren(above, [...(above.children ?? []), item])] : [one]));
}

export const canOutdent = (items: readonly MenuItem[], id: string): boolean => positionOf(items, id)?.parentId != null;

/** Out from under its link, to the top, just after that link. */
export function outdentItem(items: readonly MenuItem[], id: string): MenuItem[] {
  const at = positionOf(items, id);
  if (!at || at.parentId === null) return [...items];
  const item = at.siblings[at.index]!;
  return items.flatMap((one) => (one.id === at.parentId ? [withChildren(one, one.children!.filter((under) => under.id !== id)), item] : [one]));
}

export type Drop = { targetId: string; where: "before" | "after" | "into" };

/** Can the dragged item be dropped there? Never on itself; under a link only if it has none of its own, and only under a top-level link. */
export function canDrop(items: readonly MenuItem[], draggedId: string, drop: Drop): boolean {
  if (draggedId === drop.targetId) return false;
  const dragged = findItem(items, draggedId);
  const target = positionOf(items, drop.targetId);
  if (!dragged || !target) return false;
  // A top-level link's own links cannot take it in.
  if (dragged.children?.some((under) => under.id === drop.targetId)) return false;
  const hasChildren = !!dragged.children?.length;
  if (drop.where === "into") return target.parentId === null && !hasChildren;
  return target.parentId === null || !hasChildren;
}

/** The dragged item, moved before, after or under (as its last link) the target. */
export function dropItem(items: readonly MenuItem[], draggedId: string, drop: Drop): MenuItem[] {
  if (!canDrop(items, draggedId, drop)) return [...items];
  const dragged = findItem(items, draggedId)!;
  const rest = removeItem(items, draggedId);
  if (drop.where === "into") {
    return rest.map((one) => (one.id === drop.targetId ? withChildren(one, [...(one.children ?? []), withChildren(dragged, []) as MenuLink]) : one));
  }
  const target = positionOf(rest, drop.targetId)!;
  const offset = drop.where === "after" ? 1 : 0;
  if (target.parentId === null) {
    const next = [...rest];
    next.splice(target.index + offset, 0, dragged);
    return next;
  }
  return rest.map((one) => {
    if (one.id !== target.parentId) return one;
    const children = [...one.children!];
    children.splice(target.index + offset, 0, withChildren(dragged, []) as MenuLink);
    return withChildren(one, children);
  });
}
