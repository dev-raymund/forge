ALTER TABLE "entries" ADD COLUMN "schedule_failure" text;--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "schedule_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_schedule_failure_pair" CHECK ((schedule_failure is null) = (schedule_failed_at is null));