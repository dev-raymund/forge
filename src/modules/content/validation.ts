import { z } from "zod";
import { fieldErrorsFrom, validationError } from "@/platform/errors";
import { ENTRY_SLUG_MAX } from "./slugs";

/**
 * What the entry services accept (M5-3). Pure and client-safe: the forms of
 * M5-4 and M5-7 check the same rules before sending.
 *
 * Nothing here names an organization, a site, a role or a permission: those
 * come from the context. Ids that are here (a parent, an author, terms, an
 * image) are checked against the context's site by the services.
 */

export const ENTRY_TITLE_MAX = 200;
export const ENTRY_EXCERPT_MAX = 1_000;
/** Terms on one entry. Generous for categories and tags, and a ceiling on what one request can ask the database to check. */
export const ENTRY_TERMS_MAX = 100;

const uuid = z.uuid("Choose an item that exists.");
const title = z.string().trim().max(ENTRY_TITLE_MAX, `Use at most ${ENTRY_TITLE_MAX} characters.`);
/** A theme's template for the page (M5-6 names them: `default`, `full-width`, `landing`); null is the theme's default. */
const template = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Choose one of the theme's templates.").nullable();

/** createEntry (plan §5, cms-architecture §9.1): the type comes from the registry; the slug is made from the title. */
export const createEntrySchema = z.strictObject({
  type: z.string(),
  title: title.default(""),
  parentId: uuid.nullable().default(null),
  template: template.default(null),
  /** Someone else to credit. Only those who may edit anyone's entries of the type, and only a member. Default: the caller. */
  authorId: uuid.nullable().default(null),
});
export type CreateEntryInput = z.input<typeof createEntrySchema>;

/** A slug someone typed: it is used as it is, or refused. It is never suffixed. */
export const typedSlug = z
  .string()
  .trim()
  // One message at a time: an empty or long slug is not also told its format.
  .min(1, { message: "Enter a slug.", abort: true })
  .max(ENTRY_SLUG_MAX, { message: `Use at most ${ENTRY_SLUG_MAX} characters.`, abort: true })
  // The `entries_slug_format` CHECK's expression (isEntrySlug is this and the length).
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens, like about-us.");

/**
 * saveDraft's draft: the fields being changed, nothing else. Autosave (M5-4)
 * sends the title and the document; the sidebar (M5-7) the rest. The document
 * itself is checked by `parseDocument` (allow-list, size and node limits).
 */
export const draftSchema = z.strictObject({
  title: title.optional(),
  slug: typedSlug.optional(),
  excerpt: z.string().trim().max(ENTRY_EXCERPT_MAX, `Use at most ${ENTRY_EXCERPT_MAX} characters.`).optional(),
  template: template.optional(),
  featuredMediaId: uuid.nullable().optional(),
  content: z.unknown().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  termIds: z
    .array(uuid)
    .max(ENTRY_TERMS_MAX, `Choose at most ${ENTRY_TERMS_MAX}.`)
    .refine((ids) => new Set(ids).size === ids.length, "A term is listed twice.")
    .optional(),
});
export type DraftInput = z.input<typeof draftSchema>;

/** A draft version as the forms send it: a whole number. */
export const versionSchema = z.coerce.number().int().min(1).max(2_147_483_647);

/** Input → its schema's output, or `Validation` with each field's messages (as in the sites module). */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(fieldErrorsFrom(result.error));
  return result.data;
}
