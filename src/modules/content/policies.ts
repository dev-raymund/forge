import "server-only";
import { can, canActOn, type OrgContext } from "@/modules/tenancy";
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
