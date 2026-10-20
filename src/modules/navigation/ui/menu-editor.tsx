"use client";

import { AlertTriangle, ExternalLink, GripVertical, MoreHorizontal } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { uuidv7 } from "uuidv7";
import { FormAlert } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ENTRY_SEARCH_PATH } from "@/modules/content/shared";
import { IDLE } from "@/platform/forms";
import { saveMenuAction } from "../actions";
import {
  BLOG_LABEL, checkMenuItems, countItems, itemErrorKey, MENU_ITEMS_MAX, MENU_LABEL_MAX, targetKey,
  type EditorMenu, type MenuItem, type MenuLink, type MenuTarget,
} from "../shared";
import { canDrop, canIndent, canOutdent, dropItem, findItem, indentItem, moveItem, outdentItem, positionOf, removeItem, updateItem, type Drop } from "../tree";

/**
 * One of a site's menus, edited as a whole (M8-3; plan §19 `/…/menus`; ADR 0030).
 *
 *   add          a page or post (search), a category, the blog, or an address (a path on the site, or https/mailto/tel)
 *   arrange      drag a link by its handle: before or after another, or onto a top-level link to put it under it;
 *                or, from the keyboard, its "Arrange" menu: up, down, under the link above, out to the top level
 *   edit         a label of its own (otherwise the page's title, the category's name, "Blog"), a new tab
 *   save         the whole menu at the version the page opened; success only once the server has answered
 *
 * A link whose page is not published, is in the trash or was deleted stays in the menu, flagged: the site leaves it
 * out until its page is published again. Nothing here decides what the site shows: the server checks the menu again,
 * and the public site resolves every link itself.
 */

const INPUT =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 aria-invalid:border-destructive md:text-sm";

type EntryMatch = { id: string; type: string; title: string; path: string; status: string };
type Source = "entry" | "category" | "blog" | "url";

const SOURCES: { value: Source; label: string }[] = [
  { value: "entry", label: "Page or post" },
  { value: "category", label: "Category" },
  { value: "blog", label: "Blog" },
  { value: "url", label: "Address" },
];

const WARNINGS: Record<Exclude<MenuTarget["state"], "live">, string> = {
  unpublished: "Not on the site: it is not published. It appears once it is.",
  scheduled: "Not on the site yet: it is scheduled. It appears once it is published.",
  trashed: "Not on the site: it is in the trash. Restore and publish it, or remove this link.",
  deleted: "Not on the site: it was deleted. Remove this link.",
};

const stateOf = (status: string): MenuTarget["state"] => (status === "published" ? "live" : status === "scheduled" ? "scheduled" : "unpublished");
const ENTRY_WORDS: Record<string, string> = { page: "Page", post: "Post" };

/** The site's pages and posts matching a title (the editor's link picker's search, M5-4), a moment after the last key. */
function useEntrySearch(orgSlug: string, siteSlug: string, query: string, enabled: boolean) {
  const [results, setResults] = useState<EntryMatch[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ org: orgSlug, site: siteSlug, q: query });
        const response = await fetch(`${ENTRY_SEARCH_PATH}?${params}`, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        setResults(((await response.json()) as { entries: EntryMatch[] }).entries);
        setFailed(false);
      } catch (cause) {
        if ((cause as Error).name !== "AbortError") setFailed(true);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [orgSlug, siteSlug, query, enabled]);
  return { results, failed };
}

/** What is saved: the items only, as the server reads them. */
const stored = (items: readonly MenuItem[]) => JSON.stringify(items);

export function MenuEditor({
  orgSlug, siteSlug, title, menu, categories, blogPath,
}: {
  orgSlug: string;
  siteSlug: string;
  title: string;
  menu: EditorMenu;
  categories: { id: string; name: string; slug: string }[];
  blogPath: string;
}) {
  const { location } = menu;
  const ids = { search: useId(), category: useId(), urlLabel: useId(), url: useId(), urlTab: useId() };
  const [saved, setSaved] = useState({ items: menu.items, version: menu.version });
  const [items, setItems] = useState<MenuItem[]>(menu.items);
  const [targets, setTargets] = useState<Record<string, MenuTarget>>(menu.targets);
  const [editing, setEditing] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [pending, setPending] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  const [source, setSource] = useState<Source>("entry");
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [address, setAddress] = useState({ label: "", url: "", newTab: false });
  const [addressError, setAddressError] = useState<string | null>(null);
  const search = useEntrySearch(orgSlug, siteSlug, query, source === "entry");

  const dirty = stored(items) !== stored(saved.items);
  const count = countItems(items);
  const full = count >= MENU_ITEMS_MAX;

  const change = (next: MenuItem[], said?: string) => {
    setNotice(null);
    setItems(next);
    if (said) setAnnounce(said);
  };
  const displayOf = (item: MenuLink) => item.label || (targetKey(item) ? targets[targetKey(item)!]?.title : "") || "Untitled";

  function add(link: MenuLink, target?: MenuTarget) {
    if (full) return;
    if (target) setTargets((current) => ({ ...current, [targetKey(link)!]: target }));
    change([...items, link], `Added ${link.label || target?.title || "a link"} at the end of the menu.`);
  }
  const fresh = () => ({ id: uuidv7(), label: "", newTab: false });

  function addAddress() {
    const link: MenuLink = { ...fresh(), kind: "url", url: address.url.trim(), label: address.label.trim(), newTab: address.newTab };
    const check = checkMenuItems([link]);
    if (!check.ok) return setAddressError(Object.values(check.errors).flat()[0] ?? "Check the address.");
    setAddressError(null);
    add(check.items[0]!);
    setAddress({ label: "", url: "", newTab: false });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !dirty) return;
    setPending(true);
    setNotice(null);
    setErrors({});
    try {
      const data = new FormData();
      data.set("items", stored(items));
      data.set("version", String(saved.version));
      const result = await saveMenuAction(orgSlug, siteSlug, location, IDLE, data);
      if (result.status === "success") {
        setSaved({ items, version: Number(result.values?.version ?? saved.version) });
        setNotice({ tone: "success", text: result.message ?? "Menu saved." });
      } else {
        setErrors(result.fieldErrors ?? {});
        const general = result.fieldErrors?.items?.[0];
        setNotice({ tone: "error", text: general ?? result.message ?? "The menu was not saved." });
      }
    } catch {
      setNotice({ tone: "error", text: "The menu was not saved: the connection failed. Your changes are still here; try again." });
    } finally {
      setPending(false);
    }
  }

  const row = (item: MenuItem | MenuLink, depth: 0 | 1) => {
    const key = targetKey(item);
    const target = key ? targets[key] : undefined;
    const label = displayOf(item);
    const detail = item.kind === "url" ? item.url : (target?.detail ?? "");
    const warning = target && target.state !== "live" ? WARNINGS[target.state] : null;
    const error = errors[itemErrorKey(item.id)]?.[0];
    const at = positionOf(items, item.id);
    const isDropTarget = drop?.targetId === item.id;
    const open = editing === item.id;
    const panelId = `${location}-edit-${item.id}`;
    const children = "children" in item ? (item.children ?? []) : [];
    return (
      <li key={item.id} data-testid="menu-item" data-label={label} data-depth={depth}>
        <div
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.id);
            setDragged(item.id);
          }}
          onDragEnd={() => {
            setDragged(null);
            setDrop(null);
          }}
          onDragOver={(event) => {
            if (!dragged) return;
            const box = event.currentTarget.getBoundingClientRect();
            const y = (event.clientY - box.top) / box.height;
            const where: Drop["where"] = depth === 0 && y > 0.3 && y < 0.7 ? "into" : y < 0.5 ? "before" : "after";
            const next = { targetId: item.id, where };
            if (!canDrop(items, dragged, next)) return;
            event.preventDefault();
            setDrop(next);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const moved = dragged ? findItem(items, dragged) : null;
            if (moved && drop) change(dropItem(items, moved.id, drop), `Moved ${displayOf(moved)}.`);
            setDragged(null);
            setDrop(null);
          }}
          className={cn(
            "flex flex-wrap items-start gap-x-3 gap-y-2 border-b bg-background px-3 py-2.5 sm:flex-nowrap",
            isDropTarget && drop!.where === "before" && "shadow-[inset_0_3px_0_0_var(--foreground)]",
            isDropTarget && drop!.where === "after" && "shadow-[inset_0_-3px_0_0_var(--foreground)]",
            isDropTarget && drop!.where === "into" && "bg-muted ring-2 ring-foreground/30 ring-inset",
            dragged === item.id && "opacity-50",
          )}
          style={{ paddingLeft: `${0.75 + depth * 1.75}rem` }}
        >
          <span className="mt-0.5 cursor-grab text-muted-foreground" title="Drag to arrange" aria-hidden="true">
            <GripVertical className="size-4" />
          </span>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium wrap-anywhere">{label}</span>
              {item.newTab ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                  <ExternalLink aria-hidden="true" className="size-3" />
                  New tab
                </span>
              ) : null}
            </span>
            {detail ? <span className="text-sm text-muted-foreground wrap-anywhere">{detail}</span> : null}
            {warning ? (
              <p className="flex items-start gap-1.5 text-sm text-amber-800" data-testid="menu-item-warning">
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {warning}
              </p>
            ) : null}
            {error ? (
              <p className="text-sm font-medium text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" className="h-9 px-3" aria-expanded={open} aria-controls={panelId} onClick={() => setEditing(open ? null : item.id)}>
              {open ? "Done" : "Edit"}
              <span className="sr-only"> {label}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label={`Arrange ${label}`}>
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!at || at.index === 0} onSelect={() => change(moveItem(items, item.id, -1), `Moved ${label} up.`)}>
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!at || at.index >= at.siblings.length - 1} onSelect={() => change(moveItem(items, item.id, 1), `Moved ${label} down.`)}>
                  Move down
                </DropdownMenuItem>
                {depth === 0 ? (
                  <DropdownMenuItem disabled={!canIndent(items, item.id)} onSelect={() => change(indentItem(items, item.id), `Moved ${label} under the link above it.`)}>
                    Move under the link above
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem disabled={!canOutdent(items, item.id)} onSelect={() => change(outdentItem(items, item.id), `Moved ${label} to the top level.`)}>
                    Move out to the top level
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {open ? (
          <div id={panelId} className="grid gap-3 border-b bg-muted/40 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end" style={{ paddingLeft: `${0.75 + depth * 1.75 + 1.75}rem` }}>
            <div className="grid gap-1">
              <label htmlFor={`${panelId}-label`} className="text-sm font-medium">
                Label {item.kind !== "url" ? <span className="font-normal text-muted-foreground">· empty: {target?.title ?? "its own name"}</span> : null}
              </label>
              <input
                id={`${panelId}-label`}
                value={item.label}
                maxLength={MENU_LABEL_MAX}
                placeholder={item.kind !== "url" ? target?.title : undefined}
                onChange={(event) => change(updateItem(items, item.id, { label: event.target.value }))}
                className={INPUT}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={item.newTab} onChange={(event) => change(updateItem(items, item.id, { newTab: event.target.checked }))} className="size-4" />
                Open in a new tab
              </label>
              <Button
                type="button"
                variant="outline"
                className="h-9 px-3"
                onClick={() => {
                  setEditing(null);
                  change(removeItem(items, item.id), children.length ? `Removed ${label} and the links under it.` : `Removed ${label}.`);
                }}
              >
                Remove{children.length ? " with its links" : ""}
              </Button>
            </div>
          </div>
        ) : null}
        {children.length ? <ul>{children.map((child) => row(child, 1))}</ul> : null}
      </li>
    );
  };

  return (
    <form onSubmit={save} className="grid gap-5" aria-label={title} data-testid={`menu-${location}`} noValidate>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      {items.length ? (
        <ul className="overflow-hidden rounded-lg border [&_li:last-child>div:last-child]:border-b-0" data-testid="menu-items">
          {items.map((item) => row(item, 0))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-testid="menu-empty">
          No links yet. Add pages, posts, categories, the blog or addresses below.
        </p>
      )}

      <fieldset className="grid gap-3 rounded-lg border p-4" disabled={full}>
        <legend className="px-1 text-sm font-semibold">Add a link</legend>
        {full ? <p className="text-sm text-muted-foreground">This menu holds {MENU_ITEMS_MAX} links, the most it can. Remove one to add another.</p> : null}
        <div role="radiogroup" aria-label="What to link to" className="flex flex-wrap gap-2">
          {SOURCES.map((option) => (
            <label
              key={option.value}
              className="cursor-pointer rounded-full border px-3 py-1.5 text-sm has-checked:border-foreground has-checked:bg-foreground has-checked:text-background has-focus-visible:ring-3 has-focus-visible:ring-foreground/30"
            >
              <input type="radio" name={`${location}-source`} value={option.value} checked={source === option.value} onChange={() => setSource(option.value)} className="sr-only" />
              {option.label}
            </label>
          ))}
        </div>

        {source === "entry" ? (
          <div className="grid gap-2">
            <label htmlFor={ids.search} className="text-sm font-medium">
              Search pages and posts
            </label>
            <input id={ids.search} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title" autoComplete="off" className={INPUT} />
            {search.failed ? <p className="text-sm text-destructive">The search did not answer. Try again.</p> : null}
            {search.results && search.results.length === 0 ? <p className="text-sm text-muted-foreground">Nothing matches.</p> : null}
            {search.results?.length ? (
              <ul className="grid gap-1" data-testid="menu-search-results">
                {search.results.map((match) => (
                  <li key={match.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                    <span className="grid min-w-0">
                      <span className="text-sm font-medium wrap-anywhere">{match.title || "Untitled"}</span>
                      <span className="text-xs text-muted-foreground wrap-anywhere">
                        {ENTRY_WORDS[match.type] ?? "Page"} · {match.path}
                        {match.status !== "published" ? ` · ${match.status === "scheduled" ? "scheduled" : "not published"}` : ""}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 px-3"
                      aria-label={`Add ${match.title || "Untitled"}`}
                      onClick={() =>
                        add(
                          { ...fresh(), kind: "entry", entryId: match.id },
                          { title: match.title || "Untitled", detail: `${ENTRY_WORDS[match.type] ?? "Page"} · ${match.path}`, state: stateOf(match.status) },
                        )
                      }
                    >
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {source === "category" ? (
          categories.length ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid min-w-48 flex-1 gap-1">
                <label htmlFor={ids.category} className="text-sm font-medium">
                  Choose a category
                </label>
                <select id={ids.category} value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className={INPUT}>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-10 px-4"
                onClick={() => {
                  const category = categories.find((one) => one.id === categoryId);
                  if (category) add({ ...fresh(), kind: "term", termId: category.id }, { title: category.name, detail: `Category · ${blogPath}/category/${category.slug}`, state: "live" });
                }}
              >
                Add category
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">This site has no categories yet.</p>
          )
        ) : null}

        {source === "blog" ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">The list of all posts, at {blogPath}.</p>
            <Button
              type="button"
              variant="outline"
              className="h-10 px-4"
              onClick={() => add({ ...fresh(), kind: "archive", contentType: "post" }, { title: BLOG_LABEL, detail: `All posts · ${blogPath}`, state: "live" })}
            >
              Add the blog
            </Button>
          </div>
        ) : null}

        {source === "url" ? (
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1">
                <label htmlFor={ids.urlLabel} className="text-sm font-medium">
                  Link text
                </label>
                <input id={ids.urlLabel} value={address.label} maxLength={MENU_LABEL_MAX} onChange={(event) => setAddress({ ...address, label: event.target.value })} className={INPUT} />
              </div>
              <div className="grid gap-1">
                <label htmlFor={ids.url} className="text-sm font-medium">
                  Link to
                </label>
                <input
                  id={ids.url}
                  value={address.url}
                  placeholder="/contact or https://…"
                  aria-invalid={addressError ? true : undefined}
                  aria-describedby={addressError ? `${ids.url}-error` : undefined}
                  onChange={(event) => setAddress({ ...address, url: event.target.value })}
                  className={INPUT}
                />
              </div>
            </div>
            {addressError ? (
              <p id={`${ids.url}-error`} className="text-sm font-medium text-destructive">
                {addressError}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input id={ids.urlTab} type="checkbox" checked={address.newTab} onChange={(event) => setAddress({ ...address, newTab: event.target.checked })} className="size-4" />
                Open in a new tab
              </label>
              <Button type="button" variant="outline" className="h-10 px-4" onClick={addAddress}>
                Add address
              </Button>
            </div>
          </div>
        ) : null}
      </fieldset>

      <div className="sticky bottom-0 z-10 grid gap-3 border-t bg-background py-3">
        <div aria-live="polite" className="empty:hidden">
          {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" className="h-10 px-4" disabled={pending || !dirty} aria-busy={pending || undefined}>
            {pending ? "Saving…" : `Save ${title.toLowerCase()}`}
          </Button>
          {dirty ? (
            <>
              <span className="text-sm text-muted-foreground" data-testid={`menu-${location}-unsaved`}>
                Unsaved changes
              </span>
              <Button
                type="button"
                variant="ghost"
                className="h-10 px-3"
                onClick={() => {
                  setItems(saved.items);
                  setErrors({});
                  setNotice(null);
                  setEditing(null);
                }}
              >
                Discard changes
              </Button>
            </>
          ) : null}
          <span className="ml-auto text-sm text-muted-foreground">
            {count} of {MENU_ITEMS_MAX} links
          </span>
        </div>
      </div>
    </form>
  );
}
