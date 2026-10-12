import { z } from "zod";
import { postPath } from "../paths";
import type { ContentTypeDefinition } from "./definition";

/** Posts (plan §5): under the blog's path, with an excerpt, a featured image, an author, categories and tags. */
export const post: ContentTypeDefinition = {
  key: "post",
  label: { singular: "Post", plural: "Posts" },
  hierarchical: false,
  // A post is never the Home page and has no parent: only the blog's path and its slug count.
  routing: (entry, settings) => postPath(entry.slug, settings.blogPath),
  supports: { excerpt: true, featuredImage: true, taxonomies: ["category", "tag"], templates: false },
  fields: z.strictObject({}),
  seoDefaults: { schemaType: "BlogPosting" },
  permissionsKey: "entries.post",
};
