import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, oneOf, siteColumns, softDelete, tenantPolicy, textEnum, timestamps } from "@/platform/db/columns";
import { users } from "@/modules/auth/schema";
import { siteForeignKey } from "@/modules/sites/schema";

export const MEDIA_KINDS = ["image", "document"] as const;
export const MEDIA_STATUSES = ["pending", "ready", "failed"] as const;

/** One level of folders in the V1 UI; parent_id exists for later nesting. */
export const mediaFolders = pgTable(
  "media_folders",
  {
    id: id(),
    ...siteColumns(),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    ...timestamps(),
  },
  (t) => [
    siteForeignKey("media_folders", t),
    unique("media_folders_site_id_unique").on(t.siteId, t.id),
    unique("media_folders_site_parent_name_unique").on(t.siteId, t.parentId, t.name).nullsNotDistinct(),
    tenantPolicy("media_folders"),
  ],
).enableRLS();

export type MediaVariant = {
  key: string;
  format: "webp";
  width: number;
  height: number;
  sizeBytes: number;
  storageKey: string;
};

/**
 * media_assets — files live in object storage; this row holds metadata.
 * Variants are a JSONB column (always read with their asset) rather than a
 * table (v1-build-plan §4.1). Class: tenant.
 */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: id(),
    ...siteColumns(),
    folderId: uuid("folder_id"),
    kind: textEnum("kind", MEDIA_KINDS).notNull(),
    status: textEnum("status", MEDIA_STATUSES).notNull().default("pending"),
    storageDriver: text("storage_driver").notNull().default("s3"),
    storageKey: text("storage_key").notNull().unique(),
    version: integer("version").notNull().default(1),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    title: text("title").notNull().default(""),
    altText: text("alt_text").notNull().default(""),
    caption: text("caption").notNull().default(""),
    variants: jsonb("variants").$type<MediaVariant[]>().notNull().default([]),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    siteForeignKey("media_assets", t),
    unique("media_assets_site_id_unique").on(t.siteId, t.id),
    index("media_assets_site_created_idx")
      .on(t.siteId, t.createdAt.desc())
      .where(sql`deleted_at is null`),
    index("media_assets_site_folder_idx").on(t.siteId, t.folderId),
    oneOf("media_assets_kind_check", t.kind, MEDIA_KINDS),
    oneOf("media_assets_status_check", t.status, MEDIA_STATUSES),
    tenantPolicy("media_assets"),
  ],
).enableRLS();
