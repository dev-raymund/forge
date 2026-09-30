/**
 * Schema barrel: every table in the V1 schema (24 tables, v1-build-plan §4.2).
 * Tables are owned and defined by their modules; this file only re-exports
 * them for the Drizzle client and drizzle-kit.
 */
export * from "@/modules/auth/schema";
export * from "@/modules/tenancy/schema";
export * from "@/modules/billing/schema";
export * from "@/modules/api/schema";
export * from "@/modules/audit/schema";
export * from "@/modules/sites/schema";
export * from "@/modules/domains/schema";
export * from "@/modules/content/schema";
export * from "@/modules/media/schema";
export * from "@/modules/navigation/schema";
export * from "@/modules/seo/schema";
export * from "@/platform/jobs/schema";
