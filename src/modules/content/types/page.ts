import { z } from "zod";
import { pagePath } from "../paths";
import type { ContentTypeDefinition } from "./definition";

/** Pages (plan §5): nested by parent, a template from the theme, a sort order; the Home page is `/`. */
export const page: ContentTypeDefinition = {
  key: "page",
  label: { singular: "Page", plural: "Pages" },
  hierarchical: true,
  routing: (entry) => pagePath(entry, entry.parentPath ?? null),
  supports: { excerpt: false, featuredImage: false, taxonomies: [], templates: true },
  fields: z.strictObject({}),
  seoDefaults: { schemaType: "WebPage" },
  permissionsKey: "entries.page",
};
