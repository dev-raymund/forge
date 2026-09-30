import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, oneOf, siteColumns, softDelete, tenantPolicy, textEnum, timestamps } from "@/platform/db/columns";
import { users } from "@/modules/auth/schema";
import { siteForeignKey } from "@/modules/sites/schema";

/**
 * The entry aggregate (D-13, v1-build-plan §5):
 *   entries          identity, lifecycle and the PUBLISHED projection
 *   entry_drafts     the mutable working copy (autosave target), 1:1
 *   entry_revisions  immutable snapshots (no UPDATE grant)
 *
 * Content types are a code registry in V1 (no table): `entries.type` holds the
 * type key, so a later content_types table attaches with a composite FK on
 * (site_id, type) without backfilling ids (§4.5).
 *
 * Foreign keys that need ON DELETE SET NULL (column) — parent page, featured
 * media — and the entry → own-revision FK live in a hand-written migration.
 */

export const ENTRY_TYPES = ["page", "post"] as const;
export const ENTRY_STATUSES = ["draft", "scheduled", "published"] as const;
export const REVISION_KINDS = ["save", "publish", "scheduled", "restore"] as const;
export const TAXONOMIES = ["category", "tag"] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

const SLUG_RE = "^[a-z0-9]+(-[a-z0-9]+)*$";
const PATH_RE = "^(/[a-z0-9]+(-[a-z0-9]+)*)+$";

export const entries = pgTable(
  "entries",
  {
    id: id(),
    ...siteColumns(),
    type: textEnum("type", ENTRY_TYPES).notNull(),
    locale: text("locale").notNull(),
    parentId: uuid("parent_id"),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    status: textEnum("status", ENTRY_STATUSES).notNull().default("draft"),
    title: text("title").notNull().default(""),
    slug: text("slug").notNull(),
    path: text("path").notNull(),
    excerpt: text("excerpt").notNull().default(""),
    featuredMediaId: uuid("featured_media_id"),
    publishedRevisionId: uuid("published_revision_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    firstPublishedAt: timestamp("first_published_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    siteForeignKey("entries", t),
    unique("entries_site_id_unique").on(t.siteId, t.id),
    uniqueIndex("entries_site_locale_path_unique")
      .on(t.siteId, t.locale, t.path)
      .where(sql`deleted_at is null`),
    index("entries_list_published_idx").on(t.siteId, t.type, t.status, t.publishedAt.desc()),
    index("entries_list_updated_idx")
      .on(t.siteId, t.type, t.updatedAt.desc())
      .where(sql`deleted_at is null`),
    index("entries_tree_idx").on(t.siteId, t.parentId, t.sortOrder),
    oneOf("entries_type_check", t.type, ENTRY_TYPES),
    oneOf("entries_status_check", t.status, ENTRY_STATUSES),
    check("entries_slug_format", sql`slug ~ ${sql.raw(`'${SLUG_RE}'`)}`),
    check("entries_path_format", sql`path ~ ${sql.raw(`'${PATH_RE}'`)}`),
    // Invariants from v1-build-plan §5 / D-13, enforced by the database:
    check("entries_published_has_revision", sql`(status = 'published') = (published_revision_id is not null)`),
    check("entries_scheduled_has_time", sql`(status = 'scheduled') = (scheduled_at is not null)`),
    check("entries_trash_not_live", sql`deleted_at is null or status <> 'published'`),
    check("entries_only_pages_nest", sql`parent_id is null or type = 'page'`),
    tenantPolicy("entries"),
  ],
).enableRLS();

export const entryDrafts = pgTable(
  "entry_drafts",
  {
    entryId: uuid("entry_id").primaryKey(),
    ...siteColumns(),
    title: text("title").notNull().default(""),
    slug: text("slug").notNull(),
    excerpt: text("excerpt").notNull().default(""),
    featuredMediaId: uuid("featured_media_id"),
    template: text("template"),
    /** The block document: `{ v, doc }` in ProseMirror JSON shape (plan §6). */
    content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    seo: jsonb("seo").$type<Record<string, unknown>>().notNull().default({}),
    termIds: uuid("term_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** Optimistic concurrency token; every save increments it. */
    version: integer("version").notNull().default(1),
    contentHash: text("content_hash").notNull().default(""),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamps().updatedAt,
  },
  (t) => [
    siteForeignKey("entry_drafts", t),
    foreignKey({
      name: "entry_drafts_entry_fk",
      columns: [t.siteId, t.entryId],
      foreignColumns: [entries.siteId, entries.id],
    }).onDelete("cascade"),
    check("entry_drafts_version_positive", sql`version > 0`),
    tenantPolicy("entry_drafts"),
  ],
).enableRLS();

export const entryRevisions = pgTable(
  "entry_revisions",
  {
    id: id(),
    ...siteColumns(),
    entryId: uuid("entry_id").notNull(),
    number: integer("number").notNull(),
    kind: textEnum("kind", REVISION_KINDS).notNull(),
    label: text("label"),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    excerpt: text("excerpt").notNull().default(""),
    // History, not a live reference: no FK, so purging media never rewrites history.
    featuredMediaId: uuid("featured_media_id"),
    template: text("template"),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    seo: jsonb("seo").$type<Record<string, unknown>>().notNull().default({}),
    termIds: uuid("term_ids").array().notNull().default(sql`'{}'::uuid[]`),
    contentHash: text("content_hash").notNull(),
    sourceDraftVersion: integer("source_draft_version").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    siteForeignKey("entry_revisions", t),
    foreignKey({
      name: "entry_revisions_entry_fk",
      columns: [t.siteId, t.entryId],
      foreignColumns: [entries.siteId, entries.id],
    }).onDelete("cascade"),
    unique("entry_revisions_entry_number_unique").on(t.entryId, t.number),
    // Target of entries(id, published_revision_id): a published revision must belong to its entry.
    unique("entry_revisions_entry_id_unique").on(t.entryId, t.id),
    index("entry_revisions_entry_created_idx").on(t.entryId, t.createdAt.desc()),
    oneOf("entry_revisions_kind_check", t.kind, REVISION_KINDS),
    tenantPolicy("entry_revisions"),
  ],
).enableRLS();

export const terms = pgTable(
  "terms",
  {
    id: id(),
    ...siteColumns(),
    taxonomy: textEnum("taxonomy", TAXONOMIES).notNull(),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    ...timestamps(),
  },
  (t) => [
    siteForeignKey("terms", t),
    unique("terms_site_id_unique").on(t.siteId, t.id),
    unique("terms_site_taxonomy_slug_unique").on(t.siteId, t.taxonomy, t.slug),
    oneOf("terms_taxonomy_check", t.taxonomy, TAXONOMIES),
    check("terms_slug_format", sql`slug ~ ${sql.raw(`'${SLUG_RE}'`)}`),
    check("terms_only_categories_nest", sql`parent_id is null or taxonomy = 'category'`),
    tenantPolicy("terms"),
  ],
).enableRLS();

/** Published term assignments; draft assignments live in entry_drafts.term_ids. */
export const entryTerms = pgTable(
  "entry_terms",
  {
    ...siteColumns(),
    entryId: uuid("entry_id").notNull(),
    termId: uuid("term_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "entry_terms_pk", columns: [t.entryId, t.termId] }),
    siteForeignKey("entry_terms", t),
    foreignKey({
      name: "entry_terms_entry_fk",
      columns: [t.siteId, t.entryId],
      foreignColumns: [entries.siteId, entries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "entry_terms_term_fk",
      columns: [t.siteId, t.termId],
      foreignColumns: [terms.siteId, terms.id],
    }).onDelete("cascade"),
    index("entry_terms_term_idx").on(t.termId),
    tenantPolicy("entry_terms"),
  ],
).enableRLS();
