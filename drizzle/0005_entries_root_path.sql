-- M5-2: the Home page's path is `/` (plan §5: "Home = `/`"). Every other path keeps
-- the old rule (one or more `/segment`s), so every row valid before is valid after.
-- One Home per site and locale follows from entries_site_locale_path_unique.
ALTER TABLE "entries" DROP CONSTRAINT "entries_path_format";--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_path_format" CHECK (path = '/' or path ~ '^(/[a-z0-9]+(-[a-z0-9]+)*)+$');