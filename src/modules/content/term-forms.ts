import "server-only";
import { z } from "zod";
import type { Actor } from "@/modules/auth";
import { refusal, resolveSiteContext, type FormOutcome, type RequestMeta } from "@/modules/tenancy";
import { notFound } from "@/platform/errors";
import { text } from "@/platform/forms";
import { termListPath } from "./admin-paths";
import { createTerm, deleteTerm, updateTerm } from "./term.service";

/**
 * What the term forms do when they are submitted (M5-8): the category and tag screens, and the editor's sidebar
 * ("Add a tag"). Who is asking comes from the session; the organization and the site from the page's URL; the term's
 * id and the taxonomy are bound by the page. They name things and grant nothing: the services look the term up in
 * the context's site and ask for the permission.
 *
 * From the editor (`context=editor`), a success does not re-render the page: the editor keeps its draft and its
 * autosave, and adds the new term to its own list (as M5-7's sidebar actions do).
 */

const MODULE = "content";
const isUuid = (value: string) => z.uuid().safeParse(value).success;
const termIdFrom = (value: string) => {
  if (!isUuid(value)) throw notFound();
  return value;
};
const fromEditor = (formData: FormData) => text(formData.get("context")) === "editor";
const NOUNS: Record<string, string> = { category: "Category", tag: "Tag" };

export async function submitCreateTerm(actor: Actor, orgSlug: string, siteSlug: string, taxonomy: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const values = { name: text(formData.get("name")), slug: text(formData.get("slug")), description: text(formData.get("description")), parentId: text(formData.get("parentId")) };
  try {
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { term, events } = await createTerm(ctx, { taxonomy, name: values.name, slug: values.slug, description: values.description, parentId: values.parentId || null });
    return {
      state: { status: "success", message: `${NOUNS[term.taxonomy]} ${term.name} created.`, values: { termId: term.id, name: term.name, slug: term.slug, taxonomy: term.taxonomy } },
      revalidate: [termListPath(ctx.org.slug, ctx.site.slug, term.taxonomy)],
      invalidate: events,
      ...(fromEditor(formData) ? { refresh: false } : {}),
    };
  } catch (error) {
    return refusal(error, meta, values, termListPath(orgSlug, siteSlug, taxonomy === "category" ? "category" : "tag"), {}, MODULE);
  }
}

/** Renames the term, or changes its slug, description or (a category's) parent: only the fields the form sends. */
export async function submitUpdateTerm(actor: Actor, orgSlug: string, siteSlug: string, termId: string, formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  const field = (name: string) => (formData.has(name) ? text(formData.get(name)) : undefined);
  const values = { name: field("name"), slug: field("slug"), description: field("description"), parentId: field("parentId") };
  try {
    const id = termIdFrom(termId);
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { term, changed, events } = await updateTerm(ctx, id, {
      ...(values.name !== undefined ? { name: values.name } : {}),
      ...(values.slug !== undefined ? { slug: values.slug } : {}),
      ...(values.description !== undefined ? { description: values.description } : {}),
      ...(values.parentId !== undefined ? { parentId: values.parentId || null } : {}),
    });
    return {
      state: { status: "success", message: changed ? `${NOUNS[term.taxonomy]} saved.` : "Nothing changed.", values: { termId: term.id, name: term.name, slug: term.slug } },
      revalidate: [termListPath(ctx.org.slug, ctx.site.slug, term.taxonomy)],
      invalidate: events,
    };
  } catch (error) {
    return refusal(error, meta, Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Record<string, string>, `/${orgSlug}/sites/${siteSlug}`, {}, MODULE);
  }
}

export async function submitDeleteTerm(actor: Actor, orgSlug: string, siteSlug: string, termId: string, _formData: FormData, meta: RequestMeta = {}): Promise<FormOutcome> {
  try {
    const id = termIdFrom(termId);
    const ctx = await resolveSiteContext(actor, orgSlug, siteSlug, meta);
    const { term, posts, drafts, events } = await deleteTerm(ctx, id);
    const from = [posts ? `${posts} published ${posts === 1 ? "post" : "posts"}` : null, drafts ? `${drafts} ${drafts === 1 ? "draft" : "drafts"}` : null].filter(Boolean).join(" and ");
    return {
      state: { status: "success", message: `${NOUNS[term.taxonomy]} ${term.name} deleted${from ? `, and taken off ${from}` : ""}.` },
      revalidate: [termListPath(ctx.org.slug, ctx.site.slug, term.taxonomy)],
      invalidate: events,
    };
  } catch (error) {
    return refusal(error, meta, {}, `/${orgSlug}/sites/${siteSlug}`, {}, MODULE);
  }
}
