import type { z } from "zod";
import type { ReadingSettings } from "@/modules/sites/shared";

/**
 * What a content type is (plan §5): a code-defined definition, not a table.
 * `entries.type` holds the key; everything that depends on the type (routing,
 * what the editor offers, SEO defaults, permissions) reads it from here.
 */

export type ContentTypeKey = "page" | "post";
export type Taxonomy = "category" | "tag";

/** What routing needs of an entry: its slug, its parent's path (pages), and whether it is the site's Home page. */
export type RoutingInput = { slug: string; parentPath?: string | null; home?: boolean };

export interface ContentTypeDefinition<F extends Record<string, unknown> = Record<string, unknown>> {
  key: ContentTypeKey;
  label: { singular: string; plural: string };
  /** Pages nest (parent/child paths); posts do not. The table agrees (CHECK `entries_only_pages_nest`). */
  hierarchical: boolean;
  /** The entry's path on its site (paths.ts). */
  routing: (entry: RoutingInput, settings: Pick<ReadingSettings, "blogPath">) => string;
  supports: { excerpt: boolean; featuredImage: boolean; taxonomies: readonly Taxonomy[]; templates: boolean };
  /** The type's own fields, stored in `entry_drafts.fields` and `entry_revisions.fields`. Empty for pages and posts. */
  fields: z.ZodType<F>;
  seoDefaults: { schemaType: string; titleTemplate?: string };
  /** The prefix of the type's keys in the permission catalog: `entries.{key}.*` (ADR 0009). */
  permissionsKey: `entries.${ContentTypeKey}`;
}
