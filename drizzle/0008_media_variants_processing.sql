ALTER TABLE "media_assets" ADD COLUMN "variant_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "processing_token" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "processing_until" timestamp with time zone;