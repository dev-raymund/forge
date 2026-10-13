"use client";

import { GripVertical, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { IDLE, type FormState } from "@/platform/forms";
import { placePageAction } from "../actions";
import { entryEditorPath } from "../admin-paths";
import { MovePageDialog, pagesOutside } from "./move-page-dialog";
import { StatusBadge } from "./status-badge";

/**
 * The page tree (M5-7; plan §19 `/…/pages`): every page under its parent, in its order. For those who may arrange
 * pages:
 *
 *   drag a page by its handle among its siblings          placePageAction (before the page it is dropped on, or last)
 *   Move up / Move down in its menu (keyboard)            the same
 *   Move under… in its menu                               movePageAction: its address, and those below it, follow
 *
 * Filtered (by title or status), it is a flat list of what matches, with each page's address, and nothing is dragged:
 * an order among some of the siblings would mean nothing. The server checks every move again.
 */

export type TreePage = { id: string; title: string; path: string; status: string; parentId: string | null; isHome: boolean; changed: boolean };
type Node = TreePage & { children: Node[] };

const LINK = "rounded-sm font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-3 focus-visible:ring-foreground/25";

function treeOf(pages: readonly TreePage[]): Node[] {
  const byId = new Map<string, Node>(pages.map((page) => [page.id, { ...page, children: [] }]));
  const roots: Node[] = [];
  for (const page of pages) {
    const node = byId.get(page.id)!;
    const parent = page.parentId ? byId.get(page.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

export function PagesTree({ orgSlug, siteSlug, pages, canArrange, filtered }: { orgSlug: string; siteSlug: string; pages: TreePage[]; canArrange: boolean; filtered: boolean }) {
  const roots = useMemo(() => treeOf(pages), [pages]);
  const nodes = useMemo(() => {
    const all = new Map<string, Node>();
    const walk = (list: Node[]) => list.forEach((node) => (all.set(node.id, node), walk(node.children)));
    walk(roots);
    return all;
  }, [roots]);
  const [notice, setNotice] = useState<FormState>(IDLE);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const [dragged, setDragged] = useState<Node | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [moving, setMoving] = useState<Node | null>(null);
  const draggable = canArrange && !filtered;

  const siblingsOf = (node: Node) => (node.parentId && nodes.get(node.parentId) ? nodes.get(node.parentId)!.children : roots);

  function place(node: Node, beforeId: string | null) {
    const data = new FormData();
    data.set("beforeId", beforeId ?? "");
    startTransition(async () => {
      const state = await placePageAction(orgSlug, siteSlug, node.id, IDLE, data);
      setNotice(state);
      if (state.status === "success") router.refresh();
    });
  }
  function step(node: Node, direction: -1 | 1) {
    const siblings = siblingsOf(node);
    const index = siblings.findIndex((sibling) => sibling.id === node.id);
    if (direction === -1 && index > 0) place(node, siblings[index - 1]!.id);
    if (direction === 1 && index < siblings.length - 1) place(node, siblings[index + 2]?.id ?? null);
  }
  function dropOn(target: Node, after: boolean) {
    if (!dragged || dragged.id === target.id || dragged.parentId !== target.parentId) return;
    const siblings = siblingsOf(target).filter((sibling) => sibling.id !== dragged.id);
    const at = siblings.findIndex((sibling) => sibling.id === target.id) + (after ? 1 : 0);
    place(dragged, siblings[at]?.id ?? null);
  }

  const row = (node: Node, depth: number) => {
    const siblings = siblingsOf(node);
    const index = siblings.findIndex((sibling) => sibling.id === node.id);
    const target = drop?.id === node.id;
    return (
      <li key={node.id} data-testid="page-row" data-page={node.title}>
        <div
          draggable={draggable}
          onDragStart={(event) => {
            if (!draggable) return;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", node.id);
            setDragged(node);
          }}
          onDragEnd={() => {
            setDragged(null);
            setDrop(null);
          }}
          onDragOver={(event) => {
            if (!dragged || dragged.id === node.id || dragged.parentId !== node.parentId) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            setDrop({ id: node.id, after: event.clientY > box.top + box.height / 2 });
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (drop) dropOn(node, drop.after);
            setDragged(null);
            setDrop(null);
          }}
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2.5 sm:flex-nowrap",
            target && !drop!.after && "shadow-[inset_0_3px_0_0_var(--foreground)]",
            target && drop!.after && "shadow-[inset_0_-3px_0_0_var(--foreground)]",
            dragged?.id === node.id && "opacity-50",
          )}
          style={{ paddingLeft: `${0.75 + (filtered ? 0 : depth) * 1.25}rem` }}
        >
          {draggable ? (
            <span className="cursor-grab text-muted-foreground" title="Drag to reorder" aria-hidden="true" data-testid="page-drag">
              <GripVertical className="size-4" />
            </span>
          ) : null}
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <Link href={entryEditorPath(orgSlug, siteSlug, "page", node.id)} className={cn(LINK, "wrap-anywhere")}>
                {node.title || "Untitled"}
              </Link>
              {node.isHome ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium" data-testid="home-badge">
                  Home page
                </span>
              ) : null}
            </span>
            <span className="text-sm text-muted-foreground wrap-anywhere">{node.path}</span>
          </div>
          <StatusBadge status={node.status} changed={node.changed} />
          {canArrange ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label={`Arrange ${node.title || "Untitled"}`} disabled={pending}>
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!filtered ? (
                  <>
                    <DropdownMenuItem disabled={index <= 0} onSelect={() => step(node, -1)}>
                      Move up
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={index >= siblings.length - 1} onSelect={() => step(node, 1)}>
                      Move down
                    </DropdownMenuItem>
                  </>
                ) : null}
                <DropdownMenuItem onSelect={() => setMoving(node)}>Move under…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {!filtered && node.children.length ? <ul>{node.children.map((child) => row(child, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    <>
      <div aria-live="polite" className="mt-6 empty:hidden">
        {notice.status === "success" && notice.message ? <FormAlert tone="success">{notice.message}</FormAlert> : null}
        {notice.status === "error" ? <FormAlert tone="error">{notice.fieldErrors ? Object.values(notice.fieldErrors).flat()[0] : notice.message}</FormAlert> : null}
      </div>
      <ul className="mt-4 overflow-hidden rounded-lg border [&_li:last-child>div]:border-b-0" data-testid="pages" aria-busy={pending || undefined}>
        {(filtered ? [...nodes.values()] : roots).map((node) => row(node, 0))}
      </ul>
      {moving ? (
        <MovePageDialog
          orgSlug={orgSlug}
          siteSlug={siteSlug}
          page={moving}
          options={pagesOutside(moving.id, pages)}
          onClose={() => setMoving(null)}
          onMoved={(state) => {
            setNotice(state);
            setMoving(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
