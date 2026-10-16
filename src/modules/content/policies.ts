import "server-only";
import { can, canActOn, permissionsForRole, type OrgContext } from "@/modules/tenancy";
import { transition, type LifecycleAction, type LifecycleState } from "./lifecycle";
import type { ContentTypeKey } from "./types/definition";

/**
 * What a member may do with entries (plan §13, ADR 0009; M5-3). Asked of the
 * permissions in the context, never of a role. Every key is built from the
 * entry's type as stored (`entries.type`, checked by the registry), never from
 * request input.
 *
 *   create             entries.{type}.create                      pages: Owner–Editor · posts: Owner–Author
 *   save, publish      pages: entries.page.update / .publish      Owner–Editor
 *                      posts: entries.post.{update,publish}.any, or .own for the post's author
 *   credit someone     the "any" edit right of the type: entries.page.update / entries.post.update.any
 *   change the terms   terms.assign                               Owner–Author
 *   set the homepage   site.settings.manage                       Owner, Admin (plan §3: the homepage is a website setting)
 *   see                pages: entries.page.read, posts: entries.post.read; an Author only their own posts and no pages (M5-7)
 *   arrange pages      entries.page.update                        move under another page, or among siblings (M5-7)
 *   change the author  the type's edit right and its "any" right  Owner–Editor (M5-7)
 *   manage terms       terms.manage                               Owner–Editor: create, rename, move, delete (M5-8)
 *   create a tag       terms.manage or terms.assign               Owner–Author (M5-8)
 *   unpublish          as publish                                 (M7-1, ./lifecycle.ts)
 *   trash, restore     pages: entries.page.delete                 Owner–Editor
 *                      posts: entries.post.delete.any, or .own for the post's author (an Author: their own)
 *   purge (by hand)    pages: entries.page.delete; posts: entries.post.delete.any    Owner–Editor
 *
 * Pages have plain keys; posts have own/any pairs, for which `canActOn` with the
 * post's author is the whole policy (ADR 0009 hand-off to M5-3).
 */

/** The parts of an entry a policy reads: its type, its organization and its author. */
export type EntryRef = { readonly type: ContentTypeKey; readonly organizationId: string; readonly authorId: string | null };

const owned = (entry: EntryRef) => ({ organizationId: entry.organizationId, ownerId: entry.authorId });

export function canCreateEntry(ctx: OrgContext, type: ContentTypeKey): boolean {
  return type === "page" ? can(ctx, "entries.page.create") : can(ctx, "entries.post.create");
}

export function canUpdateEntry(ctx: OrgContext, entry: EntryRef): boolean {
  if (entry.organizationId !== ctx.org.id) return false;
  return entry.type === "page" ? can(ctx, "entries.page.update") : canActOn(ctx, "entries.post.update", owned(entry));
}

export function canPublishEntry(ctx: OrgContext, entry: EntryRef): boolean {
  if (entry.organizationId !== ctx.org.id) return false;
  return entry.type === "page" ? can(ctx, "entries.page.publish") : canActOn(ctx, "entries.post.publish", owned(entry));
}

/** May the caller credit an entry of this type to someone else? Those who may edit anyone's. */
export function canCreditOthers(ctx: OrgContext, type: ContentTypeKey): boolean {
  return type === "page" ? can(ctx, "entries.page.update") : can(ctx, "entries.post.update.any");
}

export const canAssignTerms = (ctx: OrgContext): boolean => can(ctx, "terms.assign");

export const canSetHomepage = (ctx: OrgContext): boolean => can(ctx, "site.settings.manage");

// ── M5-7: what the admin's lists and editor show, and the tree and authorship ──

/**
 * A member whose only writing right is over their own posts (plan §13: the Author) sees, in the admin, only their own
 * posts and no pages (M5-7 criterion 5; plan §21's acceptance "no settings, no pages, can write posts"). Decided from
 * permissions, never from a role: holding `entries.post.update.own` without `.any` and without any page right. Those
 * who only read (the Viewer) read everything; everyone above writes beyond their own.
 */
export function ownPostsOnly(ctx: OrgContext): boolean {
  const own = { organizationId: ctx.org.id, ownerId: ctx.actor.userId };
  return can(ctx, "entries.post.update.own", own) && !can(ctx, "entries.post.update.any") && !can(ctx, "entries.page.update");
}

/** The pages screen, the page tree and a page's editor. */
export const canSeePages = (ctx: OrgContext): boolean => can(ctx, "entries.page.read") && !ownPostsOnly(ctx);

/** A post, in the posts list or its editor: anyone's to those who read posts, only their own to an Author. */
export function canSeeEntry(ctx: OrgContext, entry: EntryRef): boolean {
  if (entry.organizationId !== ctx.org.id) return false;
  if (entry.type === "page") return canSeePages(ctx);
  return can(ctx, "entries.post.read") && (!ownPostsOnly(ctx) || entry.authorId === ctx.actor.userId);
}

/** Move a page under another, or among its siblings: those who may edit pages. */
export const canArrangePage = (ctx: OrgContext, entry: EntryRef): boolean => entry.type === "page" && canUpdateEntry(ctx, entry);

/** Credit an entry to another member: those who may edit it and may edit anyone's entries of its type (Editor+). */
export const canChangeAuthor = (ctx: OrgContext, entry: EntryRef): boolean => canUpdateEntry(ctx, entry) && canCreditOthers(ctx, entry.type);

// ── M5-8: categories and tags ────────────────────────────────────────────────

/** The category and tag screens: create, rename, move and delete any term (`terms.manage`, Owner–Editor). */
export const canManageTerms = (ctx: OrgContext): boolean => can(ctx, "terms.manage");

/**
 * Create a term: a category takes `terms.manage`; a tag also `terms.assign`, so an Author can add a tag while writing
 * (plan §13, M5-8 criterion 3). Renaming and deleting stay `terms.manage`.
 */
export const canCreateTerm = (ctx: OrgContext, taxonomy: "category" | "tag"): boolean => canManageTerms(ctx) || (taxonomy === "tag" && canAssignTerms(ctx));

// ── M7-1: the lifecycle ──────────────────────────────────────────────────────

/** Move to the trash, or restore from it: the type's delete right (an Author: their own posts). */
export function canTrashEntry(ctx: OrgContext, entry: EntryRef): boolean {
  if (entry.organizationId !== ctx.org.id) return false;
  return entry.type === "page" ? can(ctx, "entries.page.delete") : canActOn(ctx, "entries.post.delete", owned(entry));
}

/** Delete from the trash for good, before the 30 days are up: the "any" delete right (plan §9: `delete.any`). */
export function canPurgeEntry(ctx: OrgContext, entry: EntryRef): boolean {
  if (entry.organizationId !== ctx.org.id) return false;
  return entry.type === "page" ? can(ctx, "entries.page.delete") : can(ctx, "entries.post.delete.any");
}

/** May the caller take this action on this entry, in this state? The transition is allowed, and they hold its right. */
export function canTransition(ctx: OrgContext, entry: EntryRef, state: LifecycleState, action: LifecycleAction): boolean {
  const step = transition(state, action);
  if (!step.ok) return false;
  if (step.right === "system") return false; // no member does what only the job does
  if (step.right === "publish") return canPublishEntry(ctx, entry);
  return step.right === "delete" ? canTrashEntry(ctx, entry) : canPurgeEntry(ctx, entry);
}

// ── M7-2: scheduling ─────────────────────────────────────────────────────────

/**
 * May a member with this role (now) publish this entry? Asked by the scheduled publish job of the member who scheduled
 * it, when no request (and so no context) exists: their role as it is at the time, from the same catalog, never the
 * job's own. The same rule as `canPublishEntry`: pages `entries.page.publish`; posts `.any`, or `.own` for their own.
 */
export function roleMayPublish(role: string, userId: string, entry: EntryRef): boolean {
  const permissions = permissionsForRole(role);
  if (entry.type === "page") return permissions.has("entries.page.publish");
  return permissions.has("entries.post.publish.any") || (permissions.has("entries.post.publish.own") && entry.authorId === userId);
}
